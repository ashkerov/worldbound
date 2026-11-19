// Вода (URP): прозрачная поверхность, мелкая рябь, отражение неба по Френелю, блик солнца, туман.
Shader "WB/Water"
{
    Properties
    {
        _Shallow ("Shallow", Color) = (0.28, 0.52, 0.48, 0.55)
        _Deep ("Deep", Color) = (0.07, 0.22, 0.27, 0.85)
    }
    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent" "RenderPipeline"="UniversalPipeline" }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Pass
        {
            Name "Forward"
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            CBUFFER_START(UnityPerMaterial) float4 _Shallow; float4 _Deep; CBUFFER_END
            struct A { float3 pos : POSITION; float4 col : COLOR; };
            struct V { float4 cs : SV_POSITION; float3 ws : TEXCOORD0; float depth : TEXCOORD1; float fog : TEXCOORD2; };
            V vert(A a)
            {
                V o;
                o.ws = TransformObjectToWorld(a.pos);
                o.cs = TransformWorldToHClip(o.ws);
                o.depth = a.col.r; // глубина 0..1 записана в цвет вершины
                o.fog = ComputeFogFactor(o.cs.z);
                return o;
            }
            half4 frag(V i) : SV_Target
            {
                float t = _Time.y;
                float2 p = i.ws.xz;
                float3 n = normalize(float3(
                    sin(p.x * 1.7 + t * 1.3) * 0.05 + sin(p.y * 2.9 - t * 1.1 + p.x * 0.7) * 0.04 + sin((p.x + p.y) * 6.1 + t * 2.3) * 0.015,
                    1,
                    cos(p.y * 1.5 + t * 1.2) * 0.05 + cos(p.x * 2.6 + t * 0.9 - p.y * 0.5) * 0.04 + cos((p.x - p.y) * 5.7 - t * 2.1) * 0.015));
                float3 v = normalize(GetWorldSpaceViewDir(i.ws));
                float fres = pow(1 - saturate(dot(n, v)), 4);
                Light main = GetMainLight();
                float3 h = normalize(main.direction + v);
                float spec = pow(saturate(dot(n, h)), 180) * 2.2;
                float4 baseC = lerp(_Shallow, _Deep, saturate(i.depth));
                float3 sky = SampleSH(reflect(-v, n)) * 1.3;
                float3 c = lerp(baseC.rgb * (SampleSH(float3(0,1,0)) + main.color * 0.4), sky, fres * 0.8) + main.color * spec;
                return half4(MixFog(c, i.fog), saturate(baseC.a + fres * 0.35));
            }
            ENDHLSL
        }
    }
}
