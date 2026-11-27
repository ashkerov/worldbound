// Деревья и кустарники WORLDBOUND (URP): экземпляры из _FloraInstances (Graphics.RenderMeshIndirect),
// процедурная кора, листовые карточки атласа с отсечением по альфе, сезонная палитра и опадание по облиственности
// растения из снимка, снег на кронах, ветер, растворение при смене уровня детализации.
// Вершина: COLOR — цвет и затенение (a), TEXCOORD0 — uv атласа / координаты коры, TEXCOORD1 — гибкость, часть,
// случайное число карточки (у коры — тип рисунка), доля высоты.
Shader "WB/FloraWoody"
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

        struct Inst { FloraInst d; float3 wp; float3 n; WoodySpecies sp; float treeH; };

        Inst Transform(Attr a, bool wind)
        {
            Inst o;
            o.d = _FloraInstances[_FloraInstanceOffset + a.id];
            float s, c; sincos(o.d.posYaw.w, s, c);
            float3 sc = float3(o.d.scale.x, o.d.scale.y, o.d.scale.x);
            float3 lp = a.pos * sc;
            o.wp = FloraRotY(lp, s, c) + o.d.posYaw.xyz;
            o.n = normalize(FloraRotY(a.nrm / sc, s, c));
            o.sp = _FloraWoodySpecies[(uint)o.d.extra.z];
            o.treeH = max(0.5, _FloraRefHeight * o.d.scale.y);
            if (wind && _FloraBake < 0.5)
                o.wp += WoodyWind(o.wp, o.d.posYaw.xyz, o.n, a.ex.w, a.ex.x, a.ex.z, o.treeH, o.d.scale.z, a.ex.y > 0.5 ? 1 : 0, o.sp);
            return o;
        }

        // Видимость части растения: листья — по облиственности и здоровью, цветки и плоды — по сезону.
        float PartAlpha(float part, float rnd, float leaf, float health, WoodySpecies sp, float2 uv)
        {
            if (part < 0.5) return 1;
            float a = SAMPLE_TEXTURE2D(_FloraLeafAtlas, sampler_FloraLeafAtlas, uv).a;
            if (part < 1.5) return a * step(rnd, leaf * (0.6 + 0.4 * health));
            if (part < 2.5) return _FloraBake > 0.5 ? 0 : a * step(rnd, sp.bloom.a);
            return _FloraBake > 0.5 ? 0 : a * step(rnd, sp.fruit.a);
        }

        // Процедурная кора: борозды, гладкая с чечевичками, берёзовая, чешуйчатая.
        float3 Bark(float3 col, float2 uv, float type, float hFrac)
        {
            float u = uv.x, v = uv.y;
            float n1 = sin(u * FLORA_TAU * 7 + sin(v * 1.7) * 2.0) * 0.5 + 0.5;
            if (type < 0.2) // борозды
            {
                float f = smoothstep(0.55, 0.95, n1 + sin(v * 3.1 + u * 20) * 0.15);
                return col * (1 - f * 0.45);
            }
            if (type < 0.45) // гладкая
            {
                float l = step(0.92, frac(sin(dot(floor(float2(u * 24, v * 9)), float2(12.9898, 78.233))) * 43758.5453));
                return col * (0.94 + 0.06 * n1) * (1 - l * 0.25);
            }
            if (type < 0.7) // берёза: тёмные горизонтальные черточки
            {
                float2 cell = floor(float2(u * 9, v * 7));
                float r = frac(sin(dot(cell, float2(12.9898, 78.233))) * 43758.5453);
                float2 f = frac(float2(u * 9, v * 7));
                float dash = step(r, 0.42) * step(abs(f.y - 0.5), 0.09 + 0.06 * r) * step(abs(f.x - 0.5), 0.25 + 0.2 * r);
                return lerp(col, float3(0.035, 0.03, 0.028), dash * 0.85);
            }
            float sc = frac(v * 2.3 + sin(u * FLORA_TAU * 3) * 0.3); // чешуйки
            return col * (0.82 + 0.25 * smoothstep(0.1, 0.6, sc) * (0.6 + 0.4 * n1));
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
                float4 ex : TEXCOORD4; float4 inst : TEXCOORD5; nointerpolation uint sp : TEXCOORD6; float fog : TEXCOORD7;
            };
            V2F vert(Attr a)
            {
                Inst i = Transform(a, true);
                V2F o;
                o.ws = i.wp; o.n = i.n; o.col = a.col; o.uv = a.uv; o.ex = a.ex;
                o.inst = float4(i.d.scale.w, i.d.extra.x, i.d.extra.y, i.d.scale.z); // облиственность, здоровье, растворение, seed
                o.sp = (uint)i.d.extra.z;
                o.cs = TransformWorldToHClip(i.wp);
                o.fog = ComputeFogFactor(o.cs.z);
                return o;
            }
            half4 frag(V2F i, bool front : SV_IsFrontFace) : SV_Target
            {
                FloraFadeClip(i.inst.z, i.cs.xy);
                WoodySpecies sp = _FloraWoodySpecies[i.sp];
                float part = i.ex.y;
                float alpha = PartAlpha(part, i.ex.z, i.inst.x, i.inst.y, sp, i.uv);
                clip(alpha - _Cutoff);
                float3 n = normalize(i.n);
                float3 albedo;
                float ao = i.col.a;
                float translucency = 0, wrap = 0.18;
                float2 surf = FloraSurfaceAt(i.ws);
                if (part < 0.5)
                {
                    albedo = Bark(i.col.rgb, i.uv, i.ex.z, i.ex.w);
                    if (!front) n = -n;
                }
                else
                {
                    float3 tex = SAMPLE_TEXTURE2D(_FloraLeafAtlas, sampler_FloraLeafAtlas, i.uv).rgb;
                    float3 base = i.col.rgb * (0.6 + 0.45 * tex.r);
                    if (part < 1.5) albedo = WoodyLeafColor(base, i.ex.z, i.inst.y, i.inst.w, sp);
                    else if (part < 2.5) albedo = sp.bloom.rgb * (0.6 + 0.5 * tex.r);
                    else albedo = sp.fruit.rgb * (0.7 + 0.4 * tex.r);
                    translucency = sp.autumnB.a;
                    wrap = 0.55;
                }
                // Снег на обращённых вверх поверхностях кроны и ветвей.
                // Снег пятнами: только на обращённых вверх карточках и не на всех (хвоя остаётся видна).
                float patchy = part < 0.5 ? 0.45 : step(frac(i.ex.z * 7.7 + i.inst.w * 3.1), 0.72);
                float snow = surf.x * sp.misc.x * smoothstep(0.3, 0.85, n.y) * patchy;
                albedo = lerp(albedo, _FloraSnowColor.rgb, saturate(snow * 0.85));
                albedo *= 1 - surf.y * 0.25;
                #if defined(_SCREEN_SPACE_OCCLUSION)
                    float2 suv = GetNormalizedScreenSpaceUV(i.cs);
                    ao *= lerp(1, SampleAmbientOcclusion(suv), 0.6);
                #endif
                half3 lit = FloraShade(albedo, n, i.ws, ao, wrap, translucency, 1);
                lit = FloraLodTint(lit);
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
            float3 _LightDirection;
            struct V2F { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; float4 ex : TEXCOORD1; float4 inst : TEXCOORD2; nointerpolation uint sp : TEXCOORD3; };
            V2F vert(Attr a)
            {
                Inst i = Transform(a, true);
                V2F o;
                o.cs = TransformWorldToHClip(ApplyShadowBias(i.wp, i.n, _LightDirection));
                #if UNITY_REVERSED_Z
                o.cs.z = min(o.cs.z, UNITY_NEAR_CLIP_VALUE);
                #else
                o.cs.z = max(o.cs.z, UNITY_NEAR_CLIP_VALUE);
                #endif
                o.uv = a.uv; o.ex = a.ex;
                o.inst = float4(i.d.scale.w, i.d.extra.x, i.d.extra.y, 0);
                o.sp = (uint)i.d.extra.z;
                return o;
            }
            half4 frag(V2F i) : SV_Target
            {
                // Тень отбрасывает только «ближний» из двух уровней перехода — без двойной тени.
                if (i.inst.z < -0.001) discard;
                clip(PartAlpha(i.ex.y, i.ex.z, i.inst.x, i.inst.y, _FloraWoodySpecies[i.sp], i.uv) - _Cutoff);
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
            struct V2F { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; float4 ex : TEXCOORD1; float4 inst : TEXCOORD2; nointerpolation uint sp : TEXCOORD3; };
            V2F vert(Attr a)
            {
                Inst i = Transform(a, true);
                V2F o;
                o.cs = TransformWorldToHClip(i.wp);
                o.uv = a.uv; o.ex = a.ex; o.inst = float4(i.d.scale.w, i.d.extra.x, i.d.extra.y, 0); o.sp = (uint)i.d.extra.z;
                return o;
            }
            half4 frag(V2F i) : SV_Target
            {
                FloraFadeClip(i.inst.z, i.cs.xy);
                clip(PartAlpha(i.ex.y, i.ex.z, i.inst.x, i.inst.y, _FloraWoodySpecies[i.sp], i.uv) - _Cutoff);
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
            struct V2F { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; float4 ex : TEXCOORD1; float4 inst : TEXCOORD2; float3 n : TEXCOORD3; nointerpolation uint sp : TEXCOORD4; };
            V2F vert(Attr a)
            {
                Inst i = Transform(a, true);
                V2F o;
                o.cs = TransformWorldToHClip(i.wp);
                o.uv = a.uv; o.ex = a.ex; o.inst = float4(i.d.scale.w, i.d.extra.x, i.d.extra.y, 0); o.n = i.n; o.sp = (uint)i.d.extra.z;
                return o;
            }
            half4 frag(V2F i, bool front : SV_IsFrontFace) : SV_Target
            {
                FloraFadeClip(i.inst.z, i.cs.xy);
                clip(PartAlpha(i.ex.y, i.ex.z, i.inst.x, i.inst.y, _FloraWoodySpecies[i.sp], i.uv) - _Cutoff);
                float3 n = normalize(i.n);
                if (!front && i.ex.y < 0.5) n = -n;
                return FloraDepthNormal(n);
            }
            ENDHLSL
        }

        // Запекание импосторов: цвет без освещения + покрытие; нормаль в осях камеры запекания (октаэдр),
        // затенение и признак листа со случайным числом карточки (a: 0 — кора, 0.5..1 — лист).
        Pass
        {
            Name "FloraBake"
            Tags { "LightMode"="FloraBake" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            float4 _FloraBakeRight, _FloraBakeUp, _FloraBakeFwd;
            struct V2F { float4 cs : SV_POSITION; float3 n : TEXCOORD0; float4 col : TEXCOORD1; float2 uv : TEXCOORD2; float4 ex : TEXCOORD3; float4 inst : TEXCOORD4; };
            struct MRT { half4 albedo : SV_Target0; half4 normal : SV_Target1; };
            V2F vert(Attr a)
            {
                Inst i = Transform(a, false);
                V2F o;
                o.cs = TransformWorldToHClip(i.wp);
                o.n = i.n; o.col = a.col; o.uv = a.uv; o.ex = a.ex; o.inst = float4(i.d.scale.w, 1, 0, 0);
                return o;
            }
            MRT frag(V2F i, bool front : SV_IsFrontFace)
            {
                WoodySpecies sp = (WoodySpecies)0;
                float part = i.ex.y;
                float alpha = PartAlpha(part, i.ex.z, i.inst.x, 1, sp, i.uv);
                clip(alpha - 0.5);
                float3 n = normalize(i.n);
                float3 albedo;
                if (part < 0.5) { albedo = Bark(i.col.rgb, i.uv, i.ex.z, i.ex.w); if (!front) n = -n; }
                else albedo = i.col.rgb * (0.6 + 0.45 * SAMPLE_TEXTURE2D(_FloraLeafAtlas, sampler_FloraLeafAtlas, i.uv).r);
                float3 nv = float3(dot(n, _FloraBakeRight.xyz), dot(n, _FloraBakeUp.xyz), dot(n, _FloraBakeFwd.xyz));
                MRT o;
                o.albedo = half4(albedo, 1);
                o.normal = half4(FloraOctEncode(nv), i.col.a, part > 0.5 ? 0.5 + 0.5 * i.ex.z : 0);
                return o;
            }
            ENDHLSL
        }
    }
}
