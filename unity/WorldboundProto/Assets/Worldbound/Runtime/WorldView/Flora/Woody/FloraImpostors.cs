// Импосторы деревьев (уровень 3): при запуске каждая модель уровня 0 снимается ортографической камерой с 8 сторон
// на двух высотах взгляда (12° и 52°) в атлас: цвет без освещения + покрытие; нормаль (октаэдрическая), затенение
// в кроне и признак листа с его случайным числом. Дальнее дерево — один четырёхугольник, развёрнутый к камере;
// шейдер выбирает и смешивает ближайшие ракурсы, освещает по запечённой нормали и меняет цвет листвы по сезону
// так же, как модель. У лиственных есть «голая» строка — зимой и при опадании видны ветви, а не листва.

using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace Worldbound.FloraView
{
    public sealed class FloraImpostors : IDisposable
    {
        public const int Az = 8, El = 2;
        public static readonly float[] Elevations = { 12f, 52f };

        public RenderTexture Albedo, Normal;
        RenderTexture depth;
        public readonly Material Material;
        public readonly Mesh Quad;
        GraphicsBuffer rows, bakeInstance;
        public int Rows { get; private set; }
        public int Frame { get; private set; }
        public float BakeMs { get; private set; }

        public struct Row
        {
            public Mesh Mesh;
            public Bounds Bounds;
            public bool Bare;
            /// <summary>Номер «голой» строки для лиственных (−1 — нет).</summary>
            public int BareRow;
        }

        public FloraImpostors(Shader impostorShader)
        {
            Material = new Material(impostorShader) { name = "FloraImpostor", enableInstancing = true };
            Quad = new Mesh { name = "impostor-quad" };
            Quad.SetVertices(new[] { new Vector3(-1, -1, 0), new Vector3(1, -1, 0), new Vector3(1, 1, 0), new Vector3(-1, 1, 0) });
            Quad.SetUVs(0, new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1), new Vector2(0, 1) });
            Quad.SetTriangles(new[] { 0, 2, 1, 0, 3, 2 }, 0);
            Quad.bounds = new Bounds(Vector3.zero, Vector3.one * 2);
            Quad.UploadMeshData(true);
        }

        public void Bake(List<Row> list, Material woody, int frame)
        {
            var t0 = Time.realtimeSinceStartupAsDouble;
            Frame = frame;
            Rows = list.Count;
            int w = Az * El * frame, h = Math.Max(1, Rows) * frame;
            Release();
            Albedo = new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB) { name = "FloraImpostorAlbedo", useMipMap = true, autoGenerateMips = false, filterMode = FilterMode.Trilinear, wrapMode = TextureWrapMode.Clamp, anisoLevel = 2 };
            Normal = new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear) { name = "FloraImpostorNormal", useMipMap = true, autoGenerateMips = false, filterMode = FilterMode.Trilinear, wrapMode = TextureWrapMode.Clamp };
            depth = new RenderTexture(w, h, 24, RenderTextureFormat.Depth) { name = "FloraImpostorDepth" };
            Albedo.Create(); Normal.Create(); depth.Create();

            var rowData = new Vector4[Math.Max(1, Rows) * 2];
            bakeInstance = new GraphicsBuffer(GraphicsBuffer.Target.Structured, 2, 48);
            // Экземпляр 0 — с листвой, 1 — голый (облиственность 0).
            bakeInstance.SetData(new[]
            {
                new Vector4(0, 0, 0, 0), new Vector4(1, 1, 0.5f, 1), new Vector4(1, 0, 0, -1),
                new Vector4(0, 0, 0, 0), new Vector4(1, 1, 0.5f, 0), new Vector4(1, 0, 0, -1),
            });
            int pass = woody.FindPass("FloraBake");
            var cmd = new CommandBuffer { name = "FloraImpostorBake" };
            cmd.SetRenderTarget(new RenderTargetIdentifier[] { Albedo, Normal }, depth);
            cmd.ClearRenderTarget(true, true, Color.clear);
            cmd.SetGlobalFloat("_FloraBake", 1);
            var mpb = new MaterialPropertyBlock();
            mpb.SetBuffer("_FloraInstances", bakeInstance);
            for (int r = 0; r < Rows; r++)
            {
                var row = list[r];
                var b = row.Bounds;
                float radius = Mathf.Max(b.extents.x, b.extents.z, b.extents.y) * 1.04f;
                rowData[r * 2] = new Vector4(b.center.x, b.center.y, b.center.z, radius);
                rowData[r * 2 + 1] = new Vector4(row.BareRow, 0, 0, 0);
                mpb.SetInt("_FloraInstanceOffset", row.Bare ? 1 : 0);
                for (int e = 0; e < El; e++)
                    for (int a = 0; a < Az; a++)
                    {
                        float az = a * Mathf.PI * 2 / Az, el = Elevations[e] * Mathf.Deg2Rad;
                        var dir = new Vector3(Mathf.Cos(el) * Mathf.Cos(az), Mathf.Sin(el), Mathf.Cos(el) * Mathf.Sin(az));
                        float dist = radius * 3;
                        var eye = b.center + dir * dist;
                        var look = Matrix4x4.TRS(eye, Quaternion.LookRotation(-dir, Vector3.up), Vector3.one);
                        var view = Matrix4x4.Scale(new Vector3(1, 1, -1)) * look.inverse;
                        var proj = Matrix4x4.Ortho(-radius, radius, -radius, radius, dist - radius * 1.3f, dist + radius * 1.3f);
                        var fwd = -dir;
                        var right = Vector3.Cross(Vector3.up, fwd).normalized;
                        var up = Vector3.Cross(fwd, right);
                        cmd.SetViewport(new Rect((e * Az + a) * frame, r * frame, frame, frame));
                        cmd.SetViewProjectionMatrices(view, proj);
                        cmd.SetGlobalVector("_FloraBakeRight", right);
                        cmd.SetGlobalVector("_FloraBakeUp", up);
                        cmd.SetGlobalVector("_FloraBakeFwd", dir); // к камере
                        cmd.DrawMesh(row.Mesh, Matrix4x4.identity, woody, 0, pass, mpb);
                    }
            }
            cmd.SetGlobalFloat("_FloraBake", 0);
            cmd.GenerateMips(Albedo);
            cmd.GenerateMips(Normal);
            Graphics.ExecuteCommandBuffer(cmd);
            cmd.Release();
            rows = new GraphicsBuffer(GraphicsBuffer.Target.Structured, rowData.Length, 16);
            rows.SetData(rowData);
            Material.SetTexture("_ImpAlbedo", Albedo);
            Material.SetTexture("_ImpNormal", Normal);
            Material.SetBuffer("_ImpRows", rows);
            Material.SetVector("_ImpGrid", new Vector4(Az, El, Rows, frame));
            Material.SetVector("_ImpElev", new Vector4(Elevations[0] * Mathf.Deg2Rad, Elevations[1] * Mathf.Deg2Rad, Mathf.Log(frame, 2) - 2, 0));
            BakeMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
        }

        /// <summary>Объём видеопамяти атласов, байт (с мип-уровнями).</summary>
        public long Bytes => Albedo == null ? 0 : (long)(Albedo.width * Albedo.height * 8 * 1.333f);

        void Release()
        {
            if (Albedo) { Albedo.Release(); UnityEngine.Object.Destroy(Albedo); }
            if (Normal) { Normal.Release(); UnityEngine.Object.Destroy(Normal); }
            if (depth) { depth.Release(); UnityEngine.Object.Destroy(depth); }
            rows?.Release(); rows = null;
            bakeInstance?.Release(); bakeInstance = null;
        }

        public void Dispose()
        {
            Release();
            if (Material) UnityEngine.Object.Destroy(Material);
            if (Quad) UnityEngine.Object.Destroy(Quad);
        }
    }
}
