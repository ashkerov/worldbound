// Пакет экземпляров одного меша: GraphicsBuffer с данными экземпляров + Graphics.RenderMeshIndirect
// (один вызов отрисовки на пакет, сколько бы экземпляров ни было). Шейдер WB/Foliage читает _Instances по SV_InstanceID.

using System;
using System.Runtime.InteropServices;
using Unity.Collections;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace Worldbound.Gfx
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Inst
    {
        public float4 PosYaw;    // x, y, z, поворот
        public float4 ScaleSeed; // растяжение кроны, высоты, seed 0..1, облиственность 0..1
    }

    public sealed class InstanceSet : IDisposable
    {
        public readonly Mesh Mesh;
        readonly Material material;
        readonly MaterialPropertyBlock props = new();
        GraphicsBuffer buffer;
        readonly GraphicsBuffer args;
        readonly GraphicsBuffer.IndirectDrawIndexedArgs[] argData = new GraphicsBuffer.IndirectDrawIndexedArgs[1];
        public int Count { get; private set; }
        public readonly bool Shadows;

        public InstanceSet(Mesh mesh, Material material, int capacity, bool shadows)
        {
            Mesh = mesh;
            this.material = material;
            Shadows = shadows;
            args = new GraphicsBuffer(GraphicsBuffer.Target.IndirectArguments, 1, GraphicsBuffer.IndirectDrawIndexedArgs.size);
            Allocate(Math.Max(16, capacity));
        }

        void Allocate(int capacity)
        {
            buffer?.Release();
            buffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, capacity, Marshal.SizeOf<Inst>());
            props.SetBuffer("_Instances", buffer);
        }

        public void Set(NativeArray<Inst> data, int start, int count)
        {
            if (count > buffer.count) Allocate(Mathf.NextPowerOfTwo(count));
            if (count > 0) buffer.SetData(data, start, 0, count);
            Count = count;
            argData[0] = new GraphicsBuffer.IndirectDrawIndexedArgs { indexCountPerInstance = Mesh.GetIndexCount(0), instanceCount = (uint)count, startIndex = Mesh.GetIndexStart(0), baseVertexIndex = Mesh.GetBaseVertex(0), startInstance = 0 };
            args.SetData(argData);
        }

        public void Set(Inst[] data)
        {
            using var n = new NativeArray<Inst>(data, Allocator.Temp);
            Set(n, 0, data.Length);
        }

        public long Triangles => (long)Count * Mesh.GetIndexCount(0) / 3;

        public void Draw(Bounds bounds)
        {
            if (Count == 0) return;
            var rp = new RenderParams(material) { worldBounds = bounds, matProps = props, shadowCastingMode = Shadows ? ShadowCastingMode.On : ShadowCastingMode.Off, receiveShadows = true };
            Graphics.RenderMeshIndirect(rp, Mesh, args, 1);
        }

        public void Dispose()
        {
            buffer?.Release();
            args.Release();
        }
    }
}
