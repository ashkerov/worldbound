// Импосторы дальних деревьев: четырёхугольник, развёрнутый к камере; ракурс выбирается по направлению на камеру
// в осях дерева (8 азимутов × 2 высоты, смешивание соседних). Освещение — по запечённой нормали, сезонная
// окраска и опадание листвы — как у модели (тот же цвет, то же случайное число карточки), голые лиственные —
// из «голой» строки атласа.
Shader "WB/FloraImpostor"
{
    Properties
    {
        _Cutoff ("Alpha cutoff", Range(0,1)) = 0.45
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
        TEXTURE2D(_ImpAlbedo); SAMPLER(sampler_ImpAlbedo);
        TEXTURE2D(_ImpNormal); SAMPLER(sampler_ImpNormal);
        StructuredBuffer<float4> _ImpRows; // [строка × 2]: центр xyz, радиус; голая строка
        float4 _ImpGrid;  // азимутов, высот, строк, кадр px
        float4 _ImpElev;  // высоты взгляда (рад) 0 и 1, предельный мип
        float _ImpBlend;

        struct Attr { float3 pos : POSITION; float2 uv : TEXCOORD0; uint id : SV_InstanceID; };

        struct Frame
        {
            float4 cs; float3 ws; float2 uv;
            float4 sel;    // a0, a1, вес a1, вес верхней высоты
            float4 rows;   // строка, голая строка, растворение, seed
            float4 inst;   // облиственность, здоровье, номер профиля
            float3 right, up, toCam;
        };

        Frame Build(Attr a)
        {
            Frame f;
            FloraInst d = _FloraInstances[_FloraInstanceOffset + a.id];
            uint row = (uint)d.extra.w;
            float4 r0 = _ImpRows[row * 2];
            float bare = _ImpRows[row * 2 + 1].x;
            float s, c; sincos(d.posYaw.w, s, c);
            float3 sc = float3(d.scale.x, d.scale.y, d.scale.x);
            float3 centre = d.posYaw.xyz + FloraRotY(r0.xyz * sc, s, c);
            float3 toCam = _WorldSpaceCameraPos - centre;
            float3 dirW = normalize(toCam);
            float3 fwd = -dirW;
            float3 right = normalize(cross(float3(0, 1, 0), fwd));
            float3 up = cross(fwd, right);
            float3 dirL = FloraRotYInv(dirW, s, c);
            float el = asin(clamp(dirL.y, -1, 1));
            float az = atan2(dirL.z, dirL.x);
            if (az < 0) az += FLORA_TAU;
            float af = az / (FLORA_TAU / _ImpGrid.x);
            float a0 = floor(af);
            float halfW = r0.w * d.scale.x, halfH = r0.w * lerp(d.scale.y, d.scale.x, saturate(el / 1.3));
            float3 wp = centre + right * (a.pos.x * halfW) + up * (a.pos.y * halfH);
            // Небольшой сдвиг к камере: импостор не утопает в рельефе склона.
            wp += dirW * r0.w * 0.25 * d.scale.x;
            f.ws = wp;
            f.cs = TransformWorldToHClip(wp);
            f.uv = a.uv;
            f.sel = float4(fmod(a0, _ImpGrid.x), fmod(a0 + 1, _ImpGrid.x), af - a0, saturate((el - _ImpElev.x) / (_ImpElev.y - _ImpElev.x)));
            f.rows = float4(row, bare, d.extra.y, d.scale.z);
            f.inst = float4(d.scale.w, d.extra.x, d.extra.z, 0);
            f.right = right; f.up = up; f.toCam = dirW;
            return f;
        }

        float2 FrameUv(float e, float a, float row, float2 uv)
        {
            return float2((e * _ImpGrid.x + a + uv.x) / (_ImpGrid.x * _ImpGrid.y), (row + uv.y) / _ImpGrid.z);
        }

        // Смешанная выборка атласа для строки: цвет (премультипл.), нормаль+затенение+код листа, покрытие.
        void SampleRow(float row, float2 uv, float4 sel, float mip, bool blend, out float3 rgb, out float4 nrm, out float alpha)
        {
            float e0 = sel.w > 0.5 ? 1 : 0;
            float2 u00 = FrameUv(e0, sel.x, row, uv);
            float4 c00 = SAMPLE_TEXTURE2D_LOD(_ImpAlbedo, sampler_ImpAlbedo, u00, mip);
            float4 n00 = SAMPLE_TEXTURE2D_LOD(_ImpNormal, sampler_ImpNormal, u00, mip);
            if (!blend)
            {
                rgb = c00.rgb / max(c00.a, 1e-3); nrm = n00; alpha = c00.a; return;
            }
            float2 u01 = FrameUv(e0, sel.y, row, uv);
            float4 c01 = SAMPLE_TEXTURE2D_LOD(_ImpAlbedo, sampler_ImpAlbedo, u01, mip);
            float4 n01 = SAMPLE_TEXTURE2D_LOD(_ImpNormal, sampler_ImpNormal, u01, mip);
            float w1 = sel.z;
            float4 c = c00 * (1 - w1) + c01 * w1;
            nrm = (c01.a * w1 > c00.a * (1 - w1)) ? n01 : n00;
            rgb = c.rgb / max(c.a, 1e-3);
            alpha = c.a;
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
            #pragma multi_compile_fog
            struct V2F
            {
                float4 cs : SV_POSITION; float3 ws : TEXCOORD0; float2 uv : TEXCOORD1;
                nointerpolation float4 sel : TEXCOORD2; nointerpolation float4 rows : TEXCOORD3; nointerpolation float4 inst : TEXCOORD4;
                float3 right : TEXCOORD5; float3 up : TEXCOORD6; float3 toCam : TEXCOORD7; float fog : TEXCOORD8;
            };
            V2F vert(Attr a)
            {
                Frame f = Build(a);
                V2F o;
                o.cs = f.cs; o.ws = f.ws; o.uv = f.uv; o.sel = f.sel; o.rows = f.rows; o.inst = f.inst;
                o.right = f.right; o.up = f.up; o.toCam = f.toCam;
                o.fog = ComputeFogFactor(f.cs.z);
                return o;
            }
            half4 frag(V2F i) : SV_Target
            {
                FloraFadeClip(i.rows.z, i.cs.xy);
                // Мип по экранной производной; покрытие с ростом мипа добавляется (кроны не «тают»).
                float2 dims = float2(_ImpGrid.x * _ImpGrid.y, _ImpGrid.z) * _ImpGrid.w;
                float2 dx = ddx(i.uv * dims / float2(_ImpGrid.x * _ImpGrid.y, _ImpGrid.z)), dy = ddy(i.uv * dims / float2(_ImpGrid.x * _ImpGrid.y, _ImpGrid.z));
                float mip = clamp(0.5 * log2(max(dot(dx, dx), dot(dy, dy))), 0, _ImpElev.z);
                bool blend = _ImpBlend > 0.5;
                float3 rgb; float4 nrm; float alpha;
                SampleRow(i.rows.x, i.uv, i.sel, mip, blend, rgb, nrm, alpha);
                alpha = saturate(alpha * (1 + mip * 0.4));
                WoodySpecies sp = _FloraWoodySpecies[(uint)i.inst.z];
                bool isLeaf = nrm.a > 0.25;
                float rnd = saturate((nrm.a - 0.5) * 2);
                if (isLeaf && rnd > i.inst.x * (0.6 + 0.4 * i.inst.y))
                {
                    // Лист опал: вместо него — голые ветви (если у вида есть «голая» строка).
                    if (i.rows.y < 0) discard;
                    SampleRow(i.rows.y, i.uv, i.sel, mip, blend, rgb, nrm, alpha);
                    alpha = saturate(alpha * (1 + mip * 0.4));
                    isLeaf = false;
                }
                clip(alpha - _Cutoff);
                float3 nv = FloraOctDecode(nrm.xy);
                float3 n = normalize(nv.x * i.right + nv.y * i.up + nv.z * i.toCam);
                float3 albedo = isLeaf ? WoodyLeafColor(rgb, rnd, i.inst.y, i.rows.w, sp) : rgb;
                float2 surf = FloraSurfaceAt(i.ws);
                albedo = lerp(albedo, _FloraSnowColor.rgb, saturate(surf.x * sp.misc.x * saturate((n.y - 0.15) * 1.8) * 1.2));
                half3 lit = FloraShade(albedo, n, i.ws, nrm.b, isLeaf ? 0.55 : 0.2, isLeaf ? sp.autumnB.a : 0, 0);
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
            struct V2F { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; nointerpolation float4 sel : TEXCOORD1; nointerpolation float4 rows : TEXCOORD2; };
            V2F vert(Attr a) { Frame f = Build(a); V2F o; o.cs = f.cs; o.uv = f.uv; o.sel = f.sel; o.rows = f.rows; return o; }
            half4 frag(V2F i) : SV_Target
            {
                FloraFadeClip(i.rows.z, i.cs.xy);
                float3 rgb; float4 nrm; float alpha;
                SampleRow(i.rows.x, i.uv, i.sel, 2, false, rgb, nrm, alpha);
                clip(alpha * 1.6 - _Cutoff);
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
            struct V2F { float4 cs : SV_POSITION; float2 uv : TEXCOORD0; nointerpolation float4 sel : TEXCOORD1; nointerpolation float4 rows : TEXCOORD2; float3 toCam : TEXCOORD3; };
            V2F vert(Attr a) { Frame f = Build(a); V2F o; o.cs = f.cs; o.uv = f.uv; o.sel = f.sel; o.rows = f.rows; o.toCam = f.toCam; return o; }
            half4 frag(V2F i) : SV_Target
            {
                FloraFadeClip(i.rows.z, i.cs.xy);
                float3 rgb; float4 nrm; float alpha;
                SampleRow(i.rows.x, i.uv, i.sel, 2, false, rgb, nrm, alpha);
                clip(alpha * 1.6 - _Cutoff);
                return FloraDepthNormal(normalize(i.toCam + float3(0, 0.6, 0)));
            }
            ENDHLSL
        }
    }
}
