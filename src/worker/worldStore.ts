// Сохранения v1 (ARCHITECTURE.md, раздел 11.1): каталог мира, секции по поколениям, манифест.
//
//   worlds/<id>/manifest.0.json, manifest.1.json   — два слота манифеста, пишутся по очереди
//   worlds/<id>/<секция>.g<N>.bin                  — секции поколения N
//
// Атомарность: сначала пишутся секции нового поколения, затем манифест в свободный слот.
// Сбой посреди записи оставляет целым предыдущее поколение и его манифест; при загрузке
// выбирается самый новый манифест, у которого сходятся контрольные суммы всех секций.
// Удаляются только секции поколений старше предыдущего.

import type { WorldSummary } from '../shared/protocol';
import { normalizeConfig, type WorldConfig } from '../shared/worldConfig';
import { Simulation } from '../sim/core/simulation';
import type { Clock } from '../sim/core/scheduler';
import { FORMAT_VERSION, crc32, readHeader } from '../sim/persistence/binary';
import { REQUIRED_SECTIONS, SECTION_SCHEMAS, applySections, serializeWorld, type Migration, type SectionId } from '../sim/persistence/worldState';
import { WORLDGEN_VERSION, type ProgressFn } from '../sim/worldgen/generate';
import type { StoragePort } from '../platform/storage/StoragePort';

export interface SectionEntry {
  file: string;
  schema: number;
  bytes: number;
  crc: number;
}

export interface Manifest {
  format: 'worldbound-world';
  formatVersion: number;
  generation: number;
  id: string;
  name: string;
  config: WorldConfig;
  createdAt: string;
  savedAt: string;
  tick: number;
  worldgenVersion: number;
  geoHash: string;
  stateHash: string;
  /** Секции сохранения; в старых форматах части секций может не быть (тогда — миграция). */
  sections: Partial<Record<SectionId, SectionEntry>>;
  /** CRC-32 текста манифеста без этого поля. */
  check: number;
}

const ROOT = 'worlds';
const SECTION_IDS = Object.keys(SECTION_SCHEMAS) as SectionId[];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function manifestText(m: Omit<Manifest, 'check'>): string {
  return JSON.stringify(m);
}

export function newWorldId(seed: number, now: number): string {
  return `w${now.toString(36)}${(seed >>> 0).toString(36)}`;
}

export class WorldStore {
  constructor(private readonly storage: StoragePort) {}

  private dir(id: string): string {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Неверный идентификатор мира: ${id}`);
    return `${ROOT}/${id}`;
  }

  /** Самый новый целый манифест мира или null. */
  async readManifest(id: string, verifySections = true): Promise<Manifest | null> {
    const candidates: Manifest[] = [];
    for (const slot of [0, 1]) {
      const bytes = await this.storage.read(`${this.dir(id)}/manifest.${slot}.json`);
      if (!bytes) continue;
      try {
        const parsed = JSON.parse(decoder.decode(bytes)) as Manifest;
        const { check, ...rest } = parsed;
        if (parsed.format !== 'worldbound-world' || crc32(encoder.encode(manifestText(rest))) !== check) continue;
        candidates.push(parsed);
      } catch {
        // Повреждённый слот — используется другой.
      }
    }
    candidates.sort((a, b) => b.generation - a.generation);
    for (const m of candidates) {
      if (!verifySections || (await this.sectionsIntact(m))) return m;
    }
    return null;
  }

  private async sectionsIntact(m: Manifest): Promise<boolean> {
    for (const id of REQUIRED_SECTIONS) if (!m.sections[id]) return false;
    for (const id of SECTION_IDS) {
      const entry = m.sections[id];
      if (!entry) continue;
      const bytes = await this.storage.read(`${this.dir(m.id)}/${entry.file}`);
      if (!bytes || bytes.length !== entry.bytes) return false;
      try {
        const header = readHeader(bytes);
        if (header.id !== id || header.crc !== entry.crc || crc32(bytes.subarray(32)) !== entry.crc) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async list(): Promise<WorldSummary[]> {
    const names = await this.storage.list(ROOT);
    const out: WorldSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('/')) continue;
      const id = name.slice(0, -1);
      const m = await this.readManifest(id, false).catch(() => null);
      if (!m) continue;
      const bytes = Object.values(m.sections).reduce((s, e) => s + (e?.bytes ?? 0), 0);
      out.push({ id: m.id, name: m.name, config: m.config, tick: m.tick, createdAt: m.createdAt, savedAt: m.savedAt, bytes });
    }
    return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  }

  async save(sim: Simulation, meta: { id: string; createdAt: string }, now: Date): Promise<{ savedAt: string; bytes: number; generation: number }> {
    const dir = this.dir(meta.id);
    const previous = await this.readManifest(meta.id, false);
    const generation = (previous?.generation ?? 0) + 1;
    const sections = serializeWorld(sim.world);
    const entries = {} as Record<SectionId, SectionEntry>;
    let total = 0;
    for (const id of SECTION_IDS) {
      const bytes = sections[id];
      const file = `${id}.g${generation}.bin`;
      await this.storage.write(`${dir}/${file}`, bytes);
      entries[id] = { file, schema: SECTION_SCHEMAS[id], bytes: bytes.length, crc: readHeader(bytes).crc };
      total += bytes.length;
    }
    const w = sim.world;
    const savedAt = now.toISOString();
    const body: Omit<Manifest, 'check'> = {
      format: 'worldbound-world',
      formatVersion: FORMAT_VERSION,
      generation,
      id: meta.id,
      name: w.config.name,
      config: w.config,
      createdAt: meta.createdAt,
      savedAt,
      tick: w.tick,
      worldgenVersion: WORLDGEN_VERSION,
      geoHash: w.geoHash,
      stateHash: sim.stateHash(),
      sections: entries,
    };
    const manifest: Manifest = { ...body, check: crc32(encoder.encode(manifestText(body))) };
    await this.storage.write(`${dir}/manifest.${generation % 2}.json`, encoder.encode(JSON.stringify(manifest)));
    // Предыдущее поколение остаётся как резерв; более старые удаляются.
    const files = await this.storage.list(dir);
    for (const file of files) {
      const match = /\.g(\d+)\.bin$/.exec(file);
      if (match && Number(match[1]) < generation - 1) await this.storage.remove(`${dir}/${file}`);
    }
    return { savedAt, bytes: total, generation };
  }

  /** Загружает мир: генерирует статику из параметров, сверяет хеш генерации, применяет секции, сверяет хеш состояния. */
  async load(id: string, testAgents: number, clock?: Clock, progress?: ProgressFn): Promise<{ sim: Simulation; manifest: Manifest; migrations: Migration[] }> {
    const m = await this.readManifest(id);
    if (!m) throw new Error('Сохранение не найдено или повреждено');
    if (m.formatVersion > FORMAT_VERSION) throw new Error('Мир сохранён более новой версией игры');
    if (m.worldgenVersion !== WORLDGEN_VERSION) throw new Error(`Мир создан генератором версии ${m.worldgenVersion}, текущая версия ${WORLDGEN_VERSION}; перенос между версиями генератора пока не поддерживается`);
    const config = normalizeConfig(m.config);
    const sim = new Simulation({ config, testAgents, populate: false }, clock, undefined, progress);
    if (sim.world.geoHash !== m.geoHash) throw new Error('Статика мира не совпала с сохранённой (другой результат генерации)');
    const sections: Partial<Record<SectionId, Uint8Array>> = {};
    for (const sid of SECTION_IDS) {
      const entry = m.sections[sid];
      if (!entry) continue;
      if (entry.schema > SECTION_SCHEMAS[sid]) throw new Error(`Секция ${sid} сохранена более новой версией игры`);
      const bytes = await this.storage.read(`${this.dir(id)}/${entry.file}`);
      if (!bytes) throw new Error(`Нет секции ${sid}`);
      sections[sid] = bytes;
    }
    const migrations = applySections(sim.world, sections);
    // Хеш сверяется, только если состояние восстановлено без миграций: при миграции состояние
    // по определению отличается от записанного старой версией (целостность проверена CRC секций).
    if (migrations.length === 0 && sim.stateHash() !== m.stateHash) throw new Error('Хеш состояния после загрузки не совпал с сохранённым');
    return { sim, manifest: m, migrations };
  }

  async remove(id: string): Promise<boolean> {
    return this.storage.remove(this.dir(id));
  }
}
