// Точка входа Windows-сборки WORLDBOUND на Unity. По умолчанию — настоящий мир из ядра C# (WorldApp).
// Сцены оценки рендера (PrototypeApp) — только по явным аргументам -wbproto, -wbbench, -wbshots.
using System;
using UnityEngine;

namespace Worldbound.App
{
    public sealed class AppMain : MonoBehaviour
    {
        void Awake()
        {
            var args = Environment.GetCommandLineArgs();
            bool proto = Array.IndexOf(args, "-wbproto") >= 0 || Array.IndexOf(args, "-wbbench") >= 0 || Array.IndexOf(args, "-wbshots") >= 0;
            if (proto) gameObject.AddComponent<PrototypeApp>();
            else gameObject.AddComponent<WorldApp>();
        }
    }
}
