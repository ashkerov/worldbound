// Рельеф реального мира (URP): цвет вершин из статики генератора (почва, высота, уклон) × мелкая фактура,
// поверх — состояние ячеек из ядра C# (текстура _StateTex n×n, обновляется после каждого часового шага):
// R — снежный покров 0..1, G — значение выбранного слоя 0..1. _Overlay: 0 — природа, 1..5 — слои данных.
Shader "WB/WorldTerrain"
{
    Properties { _Detail ("Detail", Float) = 1 }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        CBUFFER_START(UnityPerMaterial) float _Detail; CBUFFER_END
        TEXTURE2D(_StateTex); SAMPLER(sampler_StateTex);
        float _WorldSize; float _Overlay;
        float hash21(float2 p) { p = frac(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return frac(p.x * p.y); }
        float vnoise(float2 p) { float2 i = floor(p), f = frac(p); f = f * f * (3 - 2 * f);
            return lerp(lerp(hash21(i), hash21(i + float2(1,0)), f.x), lerp(hash21(i + float2(0,1)), hash21(i + float2(1,1)), f.x), f.y); }
        float3 ramp(float t, float mode)
        {
            // Температура — сине-красная шкала, влага — от охры к синему, остальное — от тёмного к светлому.
            if (mode < 1.5)
            {
                // Холодно → тепло: синий, голубой, жёлтый, красный (без белого в середине — он сливается со снегом).
                float3 c0 = float3(0.1, 0.2, 0.85), c1 = float3(0.1, 0.75, 0.85), c2 = float3(0.95, 0.85, 0.15), c3 = float3(0.85, 0.12, 0.08);
                return t < 0.333 ? lerp(c0, c1, t * 3) : t < 0.667 ? lerp(c1, c2, t * 3 - 1) : lerp(c2, c3, t * 3 - 2);
            }
            if (mode < 2.5) return lerp(float3(0.8, 0.5, 0.15), float3(0.05, 0.3, 0.95), t);
            if (mode < 3.5) return lerp(float3(0.2, 0.25, 0.3), float3(1, 1, 1), t);
            if (mode < 4.5) return lerp(float3(0.35, 0.55, 0.85), float3(0.95, 0.95, 0.97), t);
            return lerp(float3(0.25, 0.25, 0.25), float3(0.1, 0.6, 1.0), t);
        }
        ENDHLSL
        Pass
        {
            Name "Forward"
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            struct A { float3 pos : POSITION; float3 nrm : NORMAL; float4 col : COLOR; };
            struct V { float4 cs : SV_POSITION; float3 ws : TEXCOORD0; float3 n : TEXCOORD1; float4 col : TEXCOORD2; float fog : TEXCOORD3; };
            V vert(A a)
            {
                V o;
                o.ws = TransformObjectToWorld(a.pos);
                o.cs = TransformWorldToHClip(o.ws);
                o.n = TransformObjectToWorldNormal(a.nrm);
                o.col = a.col;
                o.fog = ComputeFogFactor(o.cs.z);
                return o;
            }
            half4 frag(V i) : SV_Target
            {
                float3 n = normalize(i.n);
                float d = vnoise(i.ws.xz * 0.9) * 0.5 + vnoise(i.ws.xz * 4.1) * 0.3 + vnoise(i.ws.xz * 0.11) * 0.4;
                float3 albedo = i.col.rgb * lerp(1, 0.82 + d * 0.32, _Detail);
                float2 uv = i.ws.xz / _WorldSize;
                float inside = all(uv >= 0) && all(uv <= 1) ? 1 : 0;
                float4 st = SAMPLE_TEXTURE2D(_StateTex, sampler_StateTex, saturate(uv)) * inside;
                float snow = saturate(st.r * (0.75 + 0.5 * d));
                albedo = lerp(albedo, float3(0.93, 0.95, 0.98), snow * saturate(n.y * 1.4));
                if (_Overlay > 0.5 && inside > 0) albedo = lerp(albedo, ramp(st.g, _Overlay), 0.85);
                Light main = GetMainLight(TransformWorldToShadowCoord(i.ws));
                float ndl = saturate(dot(n, main.direction));
                float3 lit = albedo * (SampleSH(n) + main.color * ndl * main.shadowAttenuation);
                return half4(MixFog(lit, i.fog), 1);
            }
            ENDHLSL
        }
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode"="ShadowCaster" }
            ColorMask 0
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"
            float3 _LightDirection;
            struct A { float3 pos : POSITION; float3 nrm : NORMAL; };
            float4 vert(A a) : SV_POSITION
            {
                float3 w = TransformObjectToWorld(a.pos);
                float4 cs = TransformWorldToHClip(ApplyShadowBias(w, TransformObjectToWorldNormal(a.nrm), _LightDirection));
                #if UNITY_REVERSED_Z
                cs.z = min(cs.z, UNITY_NEAR_CLIP_VALUE);
                #else
                cs.z = max(cs.z, UNITY_NEAR_CLIP_VALUE);
                #endif
                return cs;
            }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }
        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode"="DepthOnly" }
            ColorMask R
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            float4 vert(float3 pos : POSITION) : SV_POSITION { return TransformObjectToHClip(pos); }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }
    }
}
