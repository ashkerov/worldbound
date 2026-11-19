// Земля, скалы, камни, дом (URP): цвет вершин × мелкая процедурная фактура, главный свет с тенями, туман.
Shader "WB/Ground"
{
    Properties { _Detail ("Detail", Float) = 1 }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        CBUFFER_START(UnityPerMaterial) float _Detail; CBUFFER_END
        float hash21(float2 p) { p = frac(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return frac(p.x * p.y); }
        float vnoise(float2 p) { float2 i = floor(p), f = frac(p); f = f * f * (3 - 2 * f);
            return lerp(lerp(hash21(i), hash21(i + float2(1,0)), f.x), lerp(hash21(i + float2(0,1)), hash21(i + float2(1,1)), f.x), f.y); }
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
                float d = vnoise(i.ws.xz * 2.3) * 0.5 + vnoise(i.ws.xz * 9.1) * 0.3 + vnoise(i.ws.xz * 0.35) * 0.4;
                float3 albedo = i.col.rgb * lerp(1, 0.82 + d * 0.32, _Detail);
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
