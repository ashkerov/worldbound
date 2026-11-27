// Ветер растительности (визуальный): сглаживание внешнего направления и скорости, накопление фаз анимации.

using UnityEngine;

namespace Worldbound.FloraView
{
    /// <summary>
    /// Ветер для шейдеров — чисто визуальный: направление и скорость приходят извне (погода), здесь только
    /// сглаживание (направление поворачивается плавно, сила меняется инерционно) и накопление фаз, чтобы смена
    /// силы не давала рывков анимации.
    /// </summary>
    public sealed class FloraWindController
    {
        float angle, speed;
        bool init;
        float time;
        Vector2 gustOffset;
        static readonly int WindId = Shader.PropertyToID("_FloraWind"), PhaseId = Shader.PropertyToID("_FloraWindPhase");
        public float Strength { get; private set; }
        public float Direction => angle;

        public void Update(in FloraEnvironment env, float dt)
        {
            if (!init) { angle = env.WindDirection; speed = env.WindSpeed; init = true; }
            float da = Mathf.DeltaAngle(angle * Mathf.Rad2Deg, env.WindDirection * Mathf.Rad2Deg) * Mathf.Deg2Rad;
            angle += Mathf.Clamp(da, -0.25f * dt, 0.25f * dt);
            speed = Mathf.Lerp(speed, env.WindSpeed, 1 - Mathf.Exp(-dt / 2.5f));
            Strength = Mathf.Clamp(speed / 12f, 0, 1.35f);
            var dir = new Vector2(Mathf.Cos(angle), Mathf.Sin(angle));
            time += dt * (0.55f + 0.6f * Strength);
            gustOffset += dir * (dt * (1.5f + speed * 0.9f));
            if (gustOffset.sqrMagnitude > 1e8f) gustOffset = Vector2.zero;
            Shader.SetGlobalVector(WindId, new Vector4(dir.x, dir.y, Strength, Mathf.Clamp01(env.Gustiness)));
            Shader.SetGlobalVector(PhaseId, new Vector4(time, gustOffset.x, gustOffset.y, 0));
        }
    }
}
