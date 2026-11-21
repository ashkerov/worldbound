# Проверка пользовательской сборки: эталонные данные golden-тестов не должны в неё попадать.
# Ищет StreamingAssets, файлы эталонов и строки-маркеры эталонов (хеши, имена инструментов) во всех файлах сборки.
# Использование: python unity/Tools/build-contents-check.py [папка сборки] [файл отчёта]
import json
import os
import sys

build = sys.argv[1] if len(sys.argv) > 1 else 'unity/WorldboundProto/Build/Windows'
out = sys.argv[2] if len(sys.argv) > 2 else None
files = []
for root, _, names in os.walk(build):
    for n in names:
        p = os.path.join(root, n)
        files.append((os.path.relpath(p, build).replace(os.sep, '/'), os.path.getsize(p)))
markers = [b'73f128cca3a9ddc9', b'267530a6fcb45b57', b'unity-env-golden', b'unity-worldgen-golden']
hits = []
for f, _ in files:
    with open(os.path.join(build, f), 'rb') as fh:
        data = fh.read()
    for m in markers:
        if m in data:
            hits.append([f, m.decode()])
report = {
    'build': build,
    'files': len(files),
    'bytes': sum(s for _, s in files),
    'streamingAssets': any('StreamingAssets' in f for f, _ in files),
    'goldenDataFiles': [f for f, _ in files if f.lower().endswith(('worldgen.json', 'env.json')) or '/golden/' in f.lower()],
    'goldenMarkersFound': hits,
    'testCodeAssemblies': [[f, s] for f, s in files if 'Golden' in f],
}
report['ok'] = not report['streamingAssets'] and not report['goldenDataFiles'] and not hits
text = json.dumps(report, ensure_ascii=False, indent=1)
print(text)
if out:
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(text + '\n')
sys.exit(0 if report['ok'] else 1)
