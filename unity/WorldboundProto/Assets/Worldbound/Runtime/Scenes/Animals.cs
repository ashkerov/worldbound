// Животные и фермер прототипа 1A (Quaternius, CC0 — assets/manifest.json основного проекта): модели GLB,
// импортированные glTFast в Resources/Models. Ходят между точками по рельефу, анимация — по скорости.

using System.Collections.Generic;
using UnityEngine;
using Worldbound.Gfx;

namespace Worldbound.Scenes
{
    public sealed class Walker : MonoBehaviour
    {
        public Vector3 Home;
        public float Radius = 12, Speed = 1.2f;
        public int Seed;
        public System.Func<float, float, float> Ground;
        Animation anim;
        string walk, idle;
        Vector3 goal;
        float wait;
        int step;

        void Start()
        {
            anim = GetComponentInChildren<Animation>();
            if (anim)
                foreach (AnimationState s in anim)
                {
                    var n = s.name.ToLowerInvariant();
                    if (walk == null && n.Contains("walk")) walk = s.name;
                    if (idle == null && (n.Contains("idle") || n.Contains("eat"))) idle = s.name;
                }
            Pick();
        }

        void Pick()
        {
            step++;
            float a = R.Rand(Seed, step, 1) * Mathf.PI * 2, r = R.Rand(Seed, step, 2) * Radius;
            goal = Home + new Vector3(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r);
            wait = 2 + R.Rand(Seed, step, 3) * 5;
        }

        void Update()
        {
            var p = transform.position;
            var to = goal - p;
            to.y = 0;
            if (to.magnitude < 0.4f)
            {
                wait -= Time.deltaTime;
                if (anim && idle != null) anim.CrossFade(idle, 0.3f);
                if (wait <= 0) Pick();
            }
            else
            {
                var dir = to.normalized;
                transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(dir), Time.deltaTime * 3);
                p += transform.forward * Speed * Time.deltaTime;
                if (anim && walk != null) anim.CrossFade(walk, 0.3f);
            }
            p.y = Ground(p.x, p.z);
            transform.position = p;
        }
    }

    public static class Animals
    {
        public static List<GameObject> Spawn(Transform parent)
        {
            var list = new List<GameObject>();
            var stag = Resources.Load<GameObject>("Models/Stag");
            var farmer = Resources.Load<GameObject>("Models/Farmer");
            void Add(GameObject prefab, Vector3 home, float scale, float speed, int seed, float radius)
            {
                if (!prefab) return;
                var go = Object.Instantiate(prefab, parent);
                go.transform.position = new Vector3(home.x, Diorama.Height(home.x, home.z), home.z);
                go.transform.localScale *= scale;
                var w = go.AddComponent<Walker>();
                w.Home = home; w.Speed = speed; w.Seed = seed; w.Radius = radius;
                w.Ground = Diorama.Height;
                foreach (var r in go.GetComponentsInChildren<Renderer>()) r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
                list.Add(go);
            }
            Add(stag, new Vector3(-48, 0, 8), 1.0f, 1.1f, 11, 10);
            Add(stag, new Vector3(-44, 0, 2), 0.85f, 1.0f, 12, 9);
            Add(stag, new Vector3(-46, 0, 5), 0.55f, 1.3f, 13, 7);
            Add(farmer, Diorama.House + new Vector3(-6, 0, -8), 1.0f, 1.0f, 14, 6);
            return list;
        }
    }
}
