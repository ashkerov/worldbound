// Определение графического адаптера. Нужно, чтобы результаты замеров можно было
// привязать к реальному железу и отличить аппаратную отрисовку от программной.

export interface GpuInfo {
  /** Человекочитаемое имя адаптера. */
  adapter: string;
  /** true, если отрисовка идёт программно (SwiftShader, WARP, llvmpipe). */
  software: boolean;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|warp|software/i;

export async function detectGpu(backend: 'webgpu' | 'webgl2'): Promise<GpuInfo> {
  let adapter = 'неизвестно';
  let software = false;
  try {
    if (backend === 'webgpu' && navigator.gpu) {
      const gpuAdapter = await navigator.gpu.requestAdapter();
      const info = gpuAdapter?.info;
      if (info) {
        adapter = [info.vendor, info.architecture, info.description || info.device].filter(Boolean).join(' · ') || adapter;
        software = info.isFallbackAdapter === true || SOFTWARE.test(adapter);
      }
    }
    if (adapter === 'неизвестно' || backend === 'webgl2') {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      if (gl && ext) {
        const name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
        if (backend === 'webgl2' || adapter === 'неизвестно') adapter = name;
        software ||= SOFTWARE.test(name);
      }
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // Диагностика необязательна: при ошибке остаётся «неизвестно».
  }
  return { adapter, software };
}
