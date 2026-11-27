// Земля графического стенда: цвет по тем же полям снимка, что и трава (виды трав и их сезон, покрытие, сухость),
// лесная подстилка под пологом, вдали — цвет полога (экономичное представление лесного массива за последним
// уровнем деревьев), снег и намокание. Пример того, как материал рельефа игры читает глобальные поля флоры.
Shader "WB/FloraStandGround"
{
    Properties
    {
        _CanopyFade ("Canopy far: start, range", Vector) = (380, 700, 0, 0)
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" "Queue"="Geometry" }

        HLSLINCLUDE
        #include "../Shaders/FloraCommon.hlsl"
        CBUFFER_START(UnityPerMaterial)
            float4 _CanopyFade;
        CBUFFER_END
        TEXTURE2D(_FloraHerbA); SAMPLER(sampler_FloraHerbA);
        TEXTURE2D(_FloraHerbB);
        TEXTURE2D(_FloraHerbCell);
        struct Attr { float3 pos : POSITION; float3 nrm : NORMAL; };
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
            #pragma multi_compile_fragment _ _SCREEN_SPACE_OCCLUSION
            #pragma multi_compile_fog
            struct V2F { float4 cs : SV_POSITION; float3 ws : TEXCOORD0; float3 n : TEXCOORD1; float fog : TEXCOORD2; };
            V2F vert(Attr a)
            {
                V2F o;
                o.ws = TransformObjectToWorld(a.pos);
                o.n = TransformObjectToWorldNormal(a.nrm);
                o.cs = TransformWorldToHClip(o.ws);
                o.fog = ComputeFogFactor(o.cs.z);
                return o;
            }

            float VNoise(float2 p)
            {
                float2 i = floor(p), f = frac(p);
                float2 u = f * f * (3 - 2 * f);
                float a = frac(sin(dot(i, float2(127.1, 311.7))) * 43758.5453), b = frac(sin(dot(i + float2(1, 0), float2(127.1, 311.7))) * 43758.5453);
                float c = frac(sin(dot(i + float2(0, 1), float2(127.1, 311.7))) * 43758.5453), d = frac(sin(dot(i + float2(1, 1), float2(127.1, 311.7))) * 43758.5453);
                return lerp(lerp(a, b, u.x), lerp(c, d, u.x), u.y);
            }

            float3 HerbColor(uint s, float green, float wgt)
            {
                HerbSpecies sp = _FloraHerbSpecies[s];
                float3 c = lerp(sp.base.rgb, sp.tip.rgb, 0.45);
                c = lerp(c, sp.autumn.rgb, sp.dry.a * 0.6);
                c = lerp(c, sp.dry.rgb * 0.9, saturate((1 - green) * 1.2));
                return c * wgt;
            }

            half4 frag(V2F i) : SV_Target
            {
                float2 uv = i.ws.xz * _FloraFieldParams.x;
                float inside = step(0, uv.x) * step(0, uv.y) * step(uv.x, 1) * step(uv.y, 1);
                float4 ha = SAMPLE_TEXTURE2D(_FloraHerbA, sampler_FloraHerbA, uv);
                float4 hb = SAMPLE_TEXTURE2D(_FloraHerbB, sampler_FloraHerbA, uv);
                float4 hc = SAMPLE_TEXTURE2D(_FloraHerbCell, sampler_FloraHerbA, uv);
                float4 cn = SAMPLE_TEXTURE2D(_FloraCanopy, sampler_FloraCanopy, uv);
                // За краем мира стенда — нейтральный луг без леса (горизонт).
                ha = lerp(float4(0.62, 0.22, 0, 0.12), ha, inside); hb = lerp(float4(0.18, 0, 0, 0), hb, inside);
                hc = lerp(float4(0.85, 0, hc.b, 0.05), hc, inside); cn = lerp(float4(0, 0, 0, 1), cn, inside);
                float n1 = VNoise(i.ws.xz * 0.35), n2 = VNoise(i.ws.xz * 0.06), n3 = VNoise(i.ws.xz * 2.1);
                // Почва: тёплый суглинок с пятнами.
                float3 soil = lerp(float3(0.085, 0.058, 0.036), float3(0.13, 0.095, 0.06), n2) * (0.85 + 0.3 * n3);
                // Смесь цветов видов трав по плотности (байт → граммы ≈ v²).
                float4 wa = ha * ha, wb = hb * hb;
                float wsum = dot(wa, 1) + dot(wb, 1);
                float green = hc.b;
                float3 herb = HerbColor(0, green, wa.x) + HerbColor(1, green, wa.y) + HerbColor(2, green, wa.z) + HerbColor(3, green, wa.w)
                            + HerbColor(4, green, wb.x) + HerbColor(5, green, wb.y) + HerbColor(6, green, wb.z) + HerbColor(7, green, wb.w);
                herb = wsum > 1e-4 ? herb / wsum : soil;
                herb *= 0.68 + 0.3 * n1;
                herb = lerp(herb, float3(0.32, 0.27, 0.15), hc.a * 0.5); // ветошь
                float cover = saturate(hc.r * 1.15);
                herb *= lerp(0.82, 1, inside);
                float3 col = lerp(soil, herb, cover * (0.75 + 0.25 * n3));
                // Лесная подстилка: хвойная — рыже-бурая, лиственная — бурая с листвой.
                float tree = cn.r;
                float3 litter = lerp(float3(0.1, 0.065, 0.038), float3(0.12, 0.06, 0.03), cn.g) * (0.8 + 0.35 * n1);
                col = lerp(col, litter, saturate(tree * 0.9) * (1 - hc.r * 0.6));
                // Вдали — цвет полога: лес остаётся лесом и за последним уровнем деревьев.
                float dist = distance(i.ws, _WorldSpaceCameraPos);
                float far = saturate((dist - _CanopyFade.x) / _CanopyFade.y) * saturate(tree * 1.4);
                float3 crownC = lerp(float3(0.045, 0.075, 0.03), float3(0.022, 0.05, 0.03), cn.g);
                float3 bare = float3(0.07, 0.06, 0.05);
                crownC = lerp(bare, crownC, lerp(cn.a, 1, cn.g));
                col = lerp(col, crownC * (0.75 + 0.5 * n2), far);
                float2 surf = FloraSurfaceAt(i.ws);
                float3 n = normalize(i.n);
                col *= 1 - surf.y * 0.3;
                float snow = saturate(surf.x * 1.3 - (1 - n.y) * 1.5 + (n3 - 0.5) * 0.25);
                col = lerp(col, _FloraSnowColor.rgb * (0.92 + 0.08 * n1), snow);
                float ao = 1;
                #if defined(_SCREEN_SPACE_OCCLUSION)
                    ao = SampleAmbientOcclusion(GetNormalizedScreenSpaceUV(i.cs));
                #endif
                float4 sc = TransformWorldToShadowCoord(i.ws);
                Light L = GetMainLight(sc, i.ws, half4(1, 1, 1, 1));
                float3 lit = col * (SampleSH(n) * ao + L.color * saturate(dot(n, L.direction)) * L.shadowAttenuation);
                lit = MixFog(lit, i.fog);
                return half4(lit, 1);
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
            float4 vert(Attr a) : SV_POSITION { return TransformWorldToHClip(TransformObjectToWorld(a.pos)); }
            half4 frag() : SV_Target { return 0; }
            ENDHLSL
        }

        Pass
        {
            Name "DepthNormals"
            Tags { "LightMode"="DepthNormals" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fragment _ _GBUFFER_NORMALS_OCT
            struct V2F { float4 cs : SV_POSITION; float3 n : TEXCOORD0; };
            V2F vert(Attr a) { V2F o; o.cs = TransformWorldToHClip(TransformObjectToWorld(a.pos)); o.n = TransformObjectToWorldNormal(a.nrm); return o; }
            half4 frag(V2F i) : SV_Target { return FloraDepthNormal(i.n); }
            ENDHLSL
        }
    }
}
