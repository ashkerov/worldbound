// Растительность WORLDBOUND (URP): экземпляры из GraphicsBuffer (Graphics.RenderMeshIndirect), ветер,
// листовые карточки с отсечением по альфе атласа, облиственность по сезону, освещение главным светом с тенями.
// Вершина: COLOR — цвет, TEXCOORD0 — uv атласа, TEXCOORD1 = (sway, part, rnd): part 0 кора, 1 листва, 2 цветки.
Shader "WB/Foliage"
{
    Properties
    {
        _MainTex ("Leaf atlas", 2D) = "white" {}
        _Cutoff ("Alpha cutoff", Range(0,1)) = 0.45
        _WindScale ("Wind scale", Float) = 1
    }
    SubShader
    {
        Tags { "RenderType"="TransparentCutout" "RenderPipeline"="UniversalPipeline" "Queue"="AlphaTest" }
        Cull Off

        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        struct Inst { float4 posYaw; float4 scaleSeed; }; // xyz, поворот; (крона, высота, seed, облиственность)
        StructuredBuffer<Inst> _Instances;
        TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
        CBUFFER_START(UnityPerMaterial)
            float4 _MainTex_ST; float _Cutoff; float _WindScale;
        CBUFFER_END
        float2 _WindDir; float _WindStrength; float4 _SeasonTint; float _LeafAmount; float _BloomAmount;

        float3 Instanced(float3 p, Inst d, float sway, out float3x3 rot)
        {
            float s, c; sincos(d.posYaw.w, s, c);
            rot = float3x3(c, 0, s, 0, 1, 0, -s, 0, c);
            float3 local = float3(p.x * d.scaleSeed.x, p.y * d.scaleSeed.y, p.z * d.scaleSeed.x);
            float3 w = mul(rot, local) + d.posYaw.xyz;
            // Ветер: изгиб по направлению, порывы бегут по ветру, дрожь листвы.
            float t = _Time.y;
            float along = dot(w.xz, _WindDir);
            float gust = sin(t * 0.55 - along * 0.018) * 0.5 + 0.5;
            float k = _WindStrength;
            float push = k * k * 0.55 + k * gust * 0.45 + sin(t * 1.6 - along * 0.12 + w.x * 0.07) * (k * 0.35 + 0.06);
            float flutter = sin(t * 6.3 + w.x * 2.1 + w.y * 2.9 + w.z * 1.7) * (k * 0.18 + 0.03);
            float amp = sway * d.scaleSeed.y * 0.12 * _WindScale;
            w.xz += (_WindDir * push + float2(-_WindDir.y, _WindDir.x) * flutter) * amp;
            w.y -= abs(push) * 0.25 * amp;
            return w;
        }
        ENDHLSL

        Pass
        {
            Name "Forward"
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            struct A { float3 pos : POSITION; float3 nrm : NORMAL; float4 col : COLOR; float2 uv : TEXCOORD0; float3 ex : TEXCOORD1; uint id : SV_InstanceID; };
            struct V { float4 cs : SV_POSITION; float3 ws : TEXCOORD0; float3 n : TEXCOORD1; float4 col : TEXCOORD2; float2 uv : TEXCOORD3; float3 ex : TEXCOORD4; float fog : TEXCOORD5; };
            V vert(A a)
            {
                Inst d = _Instances[a.id];
                float3x3 rot;
                float3 w = Instanced(a.pos, d, a.ex.x, rot);
                V o;
                o.ws = w;
                o.cs = TransformWorldToHClip(w);
                o.n = normalize(mul(rot, a.nrm / float3(d.scaleSeed.x, d.scaleSeed.y, d.scaleSeed.x)));
                // Цвет: оттенок экземпляра по seed и сезонный цвет листвы.
                float seed = d.scaleSeed.z;
                float var = 0.88 + frac(seed * 7.13) * 0.24;
                float3 c = a.col.rgb * var;
                if (a.ex.y > 0.5 && a.ex.y < 1.5) c *= _SeasonTint.rgb;
                o.col = float4(c, d.scaleSeed.w);
                o.uv = a.uv;
                o.ex = a.ex;
                o.fog = ComputeFogFactor(o.cs.z);
                return o;
            }
            half4 frag(V i, bool front : SV_IsFrontFace) : SV_Target
            {
                float part = i.ex.y;
                float alpha = 1;
                float3 albedo = i.col.rgb;
                if (part > 0.5 && part < 1.5)
                {
                    half4 tex = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
                    alpha = tex.a * step(i.ex.z, min(i.col.a, _LeafAmount));
                    albedo *= tex.rgb;
                }
                else if (part > 1.5) alpha = step(i.ex.z, _BloomAmount);
                clip(alpha - _Cutoff);
                float3 n = normalize(i.n);
                Light main = GetMainLight(TransformWorldToShadowCoord(i.ws));
                float wrap = part > 0.5 ? 0.45 : 0.15; // листва пропускает свет — мягкое «обёрнутое» освещение
                float ndl = saturate((dot(n, main.direction) + wrap) / (1 + wrap));
                float3 ambient = SampleSH(n) * 1.05;
                float3 lit = albedo * (ambient + main.color * ndl * main.shadowAttenuation);
                lit = MixFog(lit, i.fog);
                return half4(lit, 1);
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
            #pragma target 4.5
            #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"
            float3 _LightDirection;
            struct A { float3 pos : POSITION; float3 nrm : NORMAL; float4 col : COLOR; float2 uv : TEXCOORD0; float3 ex : TEXCOORD1; uint id : SV_InstanceID; };
            struct V { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; float3 ex : TEXCOORD1; float leaf : TEXCOORD2; };
            V vert(A a)
            {
                Inst d = _Instances[a.id];
                float3x3 rot;
                float3 w = Instanced(a.pos, d, a.ex.x, rot);
                float3 n = normalize(mul(rot, a.nrm));
                V o;
                o.cs = TransformWorldToHClip(ApplyShadowBias(w, n, _LightDirection));
                #if UNITY_REVERSED_Z
                o.cs.z = min(o.cs.z, UNITY_NEAR_CLIP_VALUE);
                #else
                o.cs.z = max(o.cs.z, UNITY_NEAR_CLIP_VALUE);
                #endif
                o.uv = a.uv; o.ex = a.ex; o.leaf = d.scaleSeed.w;
                return o;
            }
            half4 frag(V i) : SV_Target
            {
                float part = i.ex.y;
                float alpha = 1;
                if (part > 0.5 && part < 1.5) alpha = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv).a * step(i.ex.z, min(i.leaf, _LeafAmount));
                else if (part > 1.5) alpha = step(i.ex.z, _BloomAmount);
                clip(alpha - _Cutoff);
                return 0;
            }
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
            #pragma target 4.5
            struct A { float3 pos : POSITION; float2 uv : TEXCOORD0; float3 ex : TEXCOORD1; uint id : SV_InstanceID; };
            struct V { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; float3 ex : TEXCOORD1; float leaf : TEXCOORD2; };
            V vert(A a)
            {
                Inst d = _Instances[a.id];
                float3x3 rot;
                V o;
                o.cs = TransformWorldToHClip(Instanced(a.pos, d, a.ex.x, rot));
                o.uv = a.uv; o.ex = a.ex; o.leaf = d.scaleSeed.w;
                return o;
            }
            half4 frag(V i) : SV_Target
            {
                float part = i.ex.y;
                float alpha = 1;
                if (part > 0.5 && part < 1.5) alpha = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv).a * step(i.ex.z, min(i.leaf, _LeafAmount));
                else if (part > 1.5) alpha = step(i.ex.z, _BloomAmount);
                clip(alpha - _Cutoff);
                return 0;
            }
            ENDHLSL
        }
    }
}
