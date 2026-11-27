// Травяной покров WORLDBOUND (URP): пучки по полю трав снимка. Цвет вида от основания к кончику, осень и
// сухая/зимняя трава по зелени ячейки, ветошь, цветение и плоды по окну вида, тень полога и тени деревьев,
// снег (пригибает и покрывает), намокание. Ветер: волны порывов бегут по полю, у каждого пучка своя фаза.
Shader "WB/FloraGrass"
{
    Properties
    {
        _Cutoff ("Alpha cutoff", Range(0,1)) = 0.5
    }
    SubShader
    {
        Tags { "RenderType"="TransparentCutout" "RenderPipeline"="UniversalPipeline" "Queue"="AlphaTest" }
        Cull Off

        HLSLINCLUDE
        #include "FloraCommon.hlsl"
        CBUFFER_START(UnityPerMaterial)
            float _Cutoff;
        CBUFFER_END

        struct Attr { float3 pos : POSITION; float3 nrm : NORMAL; float4 col : COLOR; float2 uv : TEXCOORD0; float4 ex : TEXCOORD1; uint id : SV_InstanceID; };

        struct G { float3 wp; float3 n; FloraInst d; float snow; float wet; };

        G Transform(Attr a)
        {
            G g;
            g.d = _FloraInstances[_FloraInstanceOffset + a.id];
            HerbSpecies sp = _FloraHerbSpecies[(uint)g.d.extra.x];
            float2 surf = FloraSurfaceAt(g.d.posYaw.xyz);
            g.snow = surf.x; g.wet = surf.y;
            float s, c; sincos(g.d.posYaw.w, s, c);
            float sy = g.d.scale.y * (1 - g.snow * 0.75);
            float3 lp = a.pos * float3(g.d.scale.x, sy, g.d.scale.x);
            g.wp = FloraRotY(lp, s, c) + g.d.posYaw.xyz;
            g.n = normalize(FloraRotY(a.nrm, s, c));
            // Ветер: наклон по порыву + раскачивание; гибкость растёт к кончику (ex.x ≈ t²).
            float2 dir = _FloraWind.xy;
            float k = _FloraWind.z, t = _FloraWindPhase.x;
            float gust = FloraGust(g.d.posYaw.xz);
            float soft = sp.base.a;
            float ph = t * (2.1 + g.d.scale.z * 0.8) + g.d.scale.z * FLORA_TAU + dot(g.d.posYaw.xz, float2(0.23, 0.31));
            float osc = sin(ph) * 0.6 + sin(ph * 2.7 + 1.1) * 0.25;
            float bend = ((k * 0.55 + 0.06) * gust + (k * 0.25 + 0.05) * osc) * soft;
            float w = a.ex.x * (1 - g.snow * 0.8);
            float3 d3 = float3(dir.x, 0, dir.y);
            g.wp += (d3 * bend + float3(-dir.y, 0, dir.x) * osc * 0.12 * soft * (k + 0.2)) * w * sy;
            g.wp.y -= bend * bend * 0.35 * w * sy;
            return g;
        }

        float PartAlpha(float part, float rnd, float seed, float2 uv, HerbSpecies sp)
        {
            float a = uv.x < 0 ? 1 : SAMPLE_TEXTURE2D(_FloraLeafAtlas, sampler_FloraLeafAtlas, uv).a;
            if (part < 1.5) return a;
            if (part < 2.5) return a * step(frac(rnd * 3.7 + seed * 1.3), sp.tip.a);
            return a * step(frac(rnd * 5.1 + seed), sp.bloom2.a);
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
            #pragma multi_compile_fragment _ _SCREEN_SPACE_OCCLUSION
            #pragma multi_compile_fog
            struct V2F
            {
                float4 cs : SV_POSITION; float3 ws : TEXCOORD0; float3 n : TEXCOORD1; float4 col : TEXCOORD2; float2 uv : TEXCOORD3;
                float4 ex : TEXCOORD4; nointerpolation float4 inst : TEXCOORD5; nointerpolation float4 cell : TEXCOORD6; float fog : TEXCOORD7;
            };
            V2F vert(Attr a)
            {
                G g = Transform(a);
                V2F o;
                o.ws = g.wp; o.n = g.n; o.col = a.col; o.uv = a.uv; o.ex = a.ex;
                o.inst = float4(g.d.extra.x, g.d.scale.z, g.d.scale.w, g.snow);
                o.cell = float4(g.d.extra.y, g.d.extra.z, g.d.extra.w, g.wet);
                o.cs = TransformWorldToHClip(g.wp);
                o.fog = ComputeFogFactor(o.cs.z);
                return o;
            }
            half4 frag(V2F i) : SV_Target
            {
                FloraFadeClip(i.inst.z, i.cs.xy);
                HerbSpecies sp = _FloraHerbSpecies[(uint)i.inst.x];
                float part = i.ex.y, rnd = i.ex.z, seed = i.inst.y, h = i.ex.w;
                clip(PartAlpha(part, rnd, seed, i.uv, sp) - _Cutoff);
                float green = i.cell.x, straw = i.cell.y, canopy = i.cell.z, wet = i.cell.w, snow = i.inst.w;
                float3 tex = SAMPLE_TEXTURE2D(_FloraLeafAtlas, sampler_FloraLeafAtlas, abs(i.uv)).rgb;
                if (i.uv.x < 0) tex = float3(1, 1, 1);
                float3 c;
                if (part < 1.5)
                {
                    c = lerp(sp.base.rgb, sp.tip.rgb, saturate(h * 1.15)) * (0.6 + 0.5 * tex.r);
                    c = lerp(c, lerp(sp.base.rgb, sp.tip.rgb, 0.7) * 1.15, sp.autumn.a * 0.5);         // весенняя свежесть
                    c = lerp(c, sp.autumn.rgb * (0.8 + 0.35 * h), sp.dry.a * (0.6 + 0.4 * frac(rnd * 3.1 + seed)));
                    float dryK = saturate((1 - green) * 1.2);
                    c = lerp(c, sp.dry.rgb * (0.75 + 0.35 * h), dryK);
                    if (frac(rnd * 13.7 + seed * 7.1) < straw) c = sp.dry.rgb * (0.85 + 0.3 * h);    // ветошь
                    c *= 0.88 + 0.24 * frac(seed * 5.7);
                }
                else if (part < 2.5)
                {
                    // Цветки: луговые цветы — палитра окрасок по пучку; клевер — белый или розовый.
                    float pick = frac(seed * 7.3);
                    float3 pal = sp.bloom.a > 3.5
                        ? (pick < 0.3 ? float3(0.9, 0.88, 0.82) : pick < 0.55 ? float3(0.88, 0.58, 0.04) : pick < 0.72 ? float3(0.1, 0.17, 0.68) : pick < 0.86 ? float3(0.32, 0.15, 0.62) : float3(0.75, 0.12, 0.19))
                        : (pick < 0.7 ? sp.bloom.rgb : sp.bloom2.rgb);
                    c = pal * (0.7 + 0.4 * tex.r);
                }
                else c = sp.bloom2.rgb * (0.7 + 0.4 * tex.r);
                // Полог: под кронами трава темнее (рассеянный свет), вдали — за пределами карты теней.
                float shadeK = lerp(1, 0.62, canopy);
                c *= 1 - wet * 0.22;
                c = lerp(c, _FloraSnowColor.rgb, saturate(snow * (0.35 + h)));
                float3 n = normalize(lerp(i.n, float3(0, 1, 0), 0.55));
                float ao = i.col.a * lerp(1, 0.75, canopy);
                #if defined(_SCREEN_SPACE_OCCLUSION)
                    ao *= lerp(1, SampleAmbientOcclusion(GetNormalizedScreenSpaceUV(i.cs)), 0.5);
                #endif
                half3 lit = FloraShade(c * shadeK, n, i.ws, ao, 0.6, 0.45, 1);
                lit = FloraLodTint(lit);
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
            #pragma target 4.5
            struct V2F { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; float4 ex : TEXCOORD1; nointerpolation float4 inst : TEXCOORD2; };
            V2F vert(Attr a) { G g = Transform(a); V2F o; o.cs = TransformWorldToHClip(g.wp); o.uv = a.uv; o.ex = a.ex; o.inst = float4(g.d.extra.x, g.d.scale.z, g.d.scale.w, 0); return o; }
            half4 frag(V2F i) : SV_Target
            {
                FloraFadeClip(i.inst.z, i.cs.xy);
                clip(PartAlpha(i.ex.y, i.ex.z, i.inst.y, i.uv, _FloraHerbSpecies[(uint)i.inst.x]) - _Cutoff);
                return 0;
            }
            ENDHLSL
        }

        Pass
        {
            Name "DepthNormals"
            Tags { "LightMode"="DepthNormals" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #pragma multi_compile_fragment _ _GBUFFER_NORMALS_OCT
            struct V2F { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; float4 ex : TEXCOORD1; nointerpolation float4 inst : TEXCOORD2; float3 n : TEXCOORD3; };
            V2F vert(Attr a) { G g = Transform(a); V2F o; o.cs = TransformWorldToHClip(g.wp); o.uv = a.uv; o.ex = a.ex; o.inst = float4(g.d.extra.x, g.d.scale.z, g.d.scale.w, 0); o.n = g.n; return o; }
            half4 frag(V2F i) : SV_Target
            {
                FloraFadeClip(i.inst.z, i.cs.xy);
                clip(PartAlpha(i.ex.y, i.ex.z, i.inst.y, i.uv, _FloraHerbSpecies[(uint)i.inst.x]) - _Cutoff);
                return FloraDepthNormal(normalize(lerp(i.n, float3(0, 1, 0), 0.6)));
            }
            ENDHLSL
        }
    }
}
