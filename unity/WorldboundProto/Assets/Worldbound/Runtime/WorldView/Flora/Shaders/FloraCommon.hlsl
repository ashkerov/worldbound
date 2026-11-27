// Общая часть шейдеров растительности WORLDBOUND (URP): данные экземпляров и видов, ветер, сезоны, снег,
// растворение при смене уровня детализации, мягкое освещение листвы.
#ifndef WB_FLORA_COMMON
#define WB_FLORA_COMMON

#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

struct FloraInst { float4 posYaw; float4 scale; float4 extra; };

// Параметры вида древесных (FloraSeasonController): гибкость, сезонная палитра и её текущие веса.
struct WoodySpecies
{
    float4 flex;     // ствол, ветви, трепет листвы, вечнозелёный (1)
    float4 spring;   // цвет молодой листвы; a — «свежесть» сейчас
    float4 autumnA;  // осенний цвет 1; a — ход осени сейчас
    float4 autumnB;  // осенний цвет 2; a — просвечивание
    float4 bloom;    // цвет цветков; a — цветение сейчас
    float4 fruit;    // цвет плодов; a — плоды сейчас
    float4 misc;     // x — удержание снега кроной, y — хвойный
};

struct HerbSpecies
{
    float4 base;     // цвет у основания; a — 1/жёсткость
    float4 tip;      // цвет кончиков; a — цветение сейчас
    float4 dry;      // цвет сухой травы; a — ход осени сейчас
    float4 autumn;   // осенний цвет; a — «свежесть» весны
    float4 bloom;    // цвет цветков; a — вид (4 — луговые цветы с палитрой)
    float4 bloom2;   // второй цвет цветков / плодов; a — плоды сейчас
};

StructuredBuffer<FloraInst> _FloraInstances;
StructuredBuffer<WoodySpecies> _FloraWoodySpecies;
StructuredBuffer<HerbSpecies> _FloraHerbSpecies;
uint _FloraInstanceOffset;
float _FloraLodLevel;
float _FloraRefHeight; // высота эталонной модели пакета, м

float4 _FloraWind;       // направление xy, сила 0..~1.3, порывистость
float4 _FloraWindPhase;  // время ветра, смещение поля порывов xy
float4 _FloraSeason;     // доля года, снег 0..1, намокание, засушливость
float4 _FloraSnowColor;
float4 _FloraDebug;      // x — окраска по уровню детализации
float _FloraBake;
float4 _FloraFieldParams; // 1/размер мира, ячеек, размер ячейки, есть ли поле поверхности

TEXTURE2D(_FloraLeafAtlas); SAMPLER(sampler_FloraLeafAtlas);
TEXTURE2D(_FloraGust); SAMPLER(sampler_FloraGust);
TEXTURE2D(_FloraSurface); SAMPLER(sampler_FloraSurface);
TEXTURE2D(_FloraCanopy); SAMPLER(sampler_FloraCanopy);

static const float FLORA_TAU = 6.28318530718;

float3 FloraRotY(float3 p, float s, float c) { return float3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
float3 FloraRotYInv(float3 p, float s, float c) { return float3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }

float FloraLum(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

// Шум в экранных координатах (interleaved gradient noise) — узор растворения.
float FloraDither(float2 pixel) { return frac(52.9829189 * frac(dot(pixel, float2(0.06711056, 0.00583715)))); }

// f > 0 — убрать долю f пикселей; f < 0 — оставить долю |f| (взаимодополняющие узоры двух уровней).
void FloraFadeClip(float f, float2 pixel)
{
    float d = FloraDither(pixel);
    if (f > 0.001) clip(d - f);
    else if (f < -0.001) clip(-f - d);
}

// Снег и намокание в точке (поле ячеек, если передано, иначе общее значение).
float2 FloraSurfaceAt(float3 posWS)
{
    float snow = _FloraSeason.y, wet = _FloraSeason.z;
    if (_FloraFieldParams.w > 0.5)
    {
        float2 s = SAMPLE_TEXTURE2D_LOD(_FloraSurface, sampler_FloraSurface, posWS.xz * _FloraFieldParams.x, 0).rg;
        snow = saturate(s.r * max(1, _FloraSeason.y));
        wet = max(wet, s.g * 0.5);
    }
    return float2(snow, wet);
}

float FloraGust(float2 xz)
{
    float2 uv = (xz - _FloraWindPhase.yz) * 0.011;
    float g = SAMPLE_TEXTURE2D_LOD(_FloraGust, sampler_FloraGust, uv, 0).r;
    return lerp(1, saturate(g * 1.9 - 0.25), _FloraWind.w);
}

// Ветер древесного: наклон и раскачивание ствола (медленнее у высоких), качание ветвей, трепет листвы.
float3 WoodyWind(float3 wp, float3 basePos, float3 nWS, float hFrac, float branch, float rnd, float treeH, float seed, float isLeaf, WoodySpecies sp)
{
    float2 dir = _FloraWind.xy;
    float k = _FloraWind.z;
    float t = _FloraWindPhase.x;
    float gust = FloraGust(basePos.xz);
    float3 d3 = float3(dir.x, 0, dir.y);
    float freq = 2.6 / sqrt(max(1.2, treeH));
    float osc = sin(t * freq + seed * FLORA_TAU) * 0.5 + sin(t * freq * 2.3 + seed * 11.0) * 0.18;
    float lean = (k * k * 0.9 + k * 0.25) * gust;
    float amp = (lean * 0.035 + (0.012 + k * 0.022) * osc) * sp.flex.x * treeH;
    float h2 = hFrac * hFrac;
    float3 off = d3 * amp * h2;
    off.y -= abs(amp) * h2 * hFrac * 0.25;
    // Ветви: фаза по положению — соседние ветви и деревья качаются вразнобой.
    float bph = t * (1.6 + seed * 0.8) + dot(wp, float3(0.37, 0.21, 0.29));
    float3 bs = d3 * (sin(bph) * 0.6 + 0.4 * gust) + float3(0, sin(bph * 1.37 + 1.3) * 0.5, 0) + float3(-dir.y, 0, dir.x) * sin(bph * 0.71) * 0.35;
    off += bs * branch * (0.03 + k * 0.16) * sp.flex.y * saturate(treeH / 6) * (0.6 + 0.4 * gust);
    // Листья: мелкий высокочастотный трепет вдоль нормали.
    float fl = sin(t * 9.1 + rnd * 37.0 + wp.x * 1.9 + wp.z * 1.3) * sin(t * 5.3 + rnd * 17.0);
    off += nWS * fl * isLeaf * (0.012 + k * 0.045) * sp.flex.z * branch;
    return off;
}

// Цвет листвы древесного по сезону: молодая листва весной, постепенная осенняя окраска карточка за карточкой,
// болезнь — желтизна, вариация оттенка по растению.
float3 WoodyLeafColor(float3 vcol, float rnd, float health, float seed, WoodySpecies sp)
{
    float3 c = vcol;
    float fresh = sp.spring.a * (0.55 + 0.45 * rnd);
    c = lerp(c, sp.spring.rgb * (0.45 + 0.35 * saturate(FloraLum(vcol) / 0.15)), fresh * 0.7);
    float turn = saturate((sp.autumnA.a * 1.25 - rnd * 0.6 - seed * 0.25) * 3.0);
    float3 ac = lerp(sp.autumnA.rgb, sp.autumnB.rgb, frac(rnd * 7.31 + seed * 3.7));
    ac *= 0.42 + 0.38 * saturate(FloraLum(vcol) / 0.15);
    c = lerp(c, ac, turn * (1 - sp.flex.w));
    float sick = saturate(1 - health) * 0.4;
    c = lerp(c, float3(0.2, 0.17, 0.06) * (0.7 + 2.0 * FloraLum(c)), sick);
    float hue = seed - 0.5;
    c *= float3(1 + hue * 0.08, 1 + hue * 0.03, 1 - hue * 0.12) * (0.92 + 0.16 * frac(seed * 5.3));
    return c;
}

// Мягкое освещение растительности: обёрнутый диффуз, просвечивание на контровом свете, полусферический
// амбиент с затенением кроны, без бликов («не пластик»).
half3 FloraShade(float3 albedo, float3 n, float3 posWS, float ao, float wrap, float translucency, float shadowOn)
{
    float4 sc = TransformWorldToShadowCoord(posWS);
    Light L = GetMainLight(sc, posWS, half4(1, 1, 1, 1));
    float sh = lerp(1, L.shadowAttenuation, shadowOn);
    float ndl = dot(n, L.direction);
    float diff = saturate((ndl + wrap) / (1 + wrap));
    float3 V = normalize(GetWorldSpaceViewDir(posWS));
    float back = pow(saturate(dot(V, -L.direction)), 3.0) * translucency;
    float3 direct = L.color * sh * (diff + back * float3(0.85, 1.0, 0.55));
    // Амбиент по нормали, приподнятой к небу: нижняя сторона кроны темнее, но не проваливается в черноту.
    float3 amb = SampleSH(normalize(n + float3(0, 0.6, 0))) * (0.3 + 0.7 * ao);
    return albedo * (amb + direct * (0.5 + 0.5 * ao));
}

float3 FloraLodTint(float3 c)
{
    if (_FloraDebug.x < 0.5) return c;
    float3 t = _FloraLodLevel < 0.5 ? float3(0.2, 1, 0.2) : _FloraLodLevel < 1.5 ? float3(1, 1, 0.1) : _FloraLodLevel < 2.5 ? float3(1, 0.45, 0.1) : float3(0.9, 0.2, 0.9);
    return lerp(c, t * (0.3 + FloraLum(c) * 2.0), 0.7);
}

float2 FloraOctEncode(float3 n)
{
    n /= (abs(n.x) + abs(n.y) + abs(n.z));
    float2 o = n.z >= 0 ? n.xy : (1 - abs(n.yx)) * float2(n.x >= 0 ? 1 : -1, n.y >= 0 ? 1 : -1);
    return o * 0.5 + 0.5;
}

float3 FloraOctDecode(float2 e)
{
    e = e * 2 - 1;
    float3 n = float3(e.x, e.y, 1 - abs(e.x) - abs(e.y));
    float t = saturate(-n.z);
    n.xy += float2(n.x >= 0 ? -t : t, n.y >= 0 ? -t : t);
    return normalize(n);
}

// Пакованные нормали для прохода DepthNormals (SSAO URP).
half4 FloraDepthNormal(float3 n)
{
    #if defined(_GBUFFER_NORMALS_OCT)
        float2 o = PackNormalOctQuadEncode(normalize(n));
        float2 r = saturate(o * 0.5 + 0.5);
        return half4(PackFloat2To888(r), 0);
    #else
        return half4(normalize(n), 0);
    #endif
}

#endif
