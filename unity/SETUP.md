# Unity-прототип WORLDBOUND: что нужно установить

Ветка `experiment/unity-windows-prototype` — эксперимент оценки Unity (`docs/UNITY_EVALUATION_REPORT.md` будет здесь же).
Основной проект на TypeScript не меняется; ветка `main` остаётся рабочей.

Состояние машины на 2026-11-19: Unity Hub и Unity Editor **не установлены**, .NET SDK не установлен, свободно 235 ГБ на диске C.

## 1. Что установить (бесплатно)

| Что | Зачем | Размер (ориентир) |
|---|---|---|
| Unity Hub | Установка редактора и лицензия Unity Personal | ~0,5 ГБ |
| Unity 6.3 LTS (6000.3.x, последний патч) | Редактор; в нём уже есть URP, Input System, Jobs, Burst, Test Framework | ~7–9 ГБ |
| Модуль «Windows Build Support (Mono)» | Сборка Windows x64 — для прототипа достаточно | входит в редактор для Windows |
| Модуль «Windows Build Support (IL2CPP)» — **не нужен сейчас** | Нужен позже для релизной сборки под Steam; требует Visual Studio с C++ (~7 ГБ) | — |
| Редактор кода — по желанию | VS Code с расширениями C# Dev Kit и Unity, или JetBrains Rider (платный) | — |

Unity Personal бесплатен при доходе до 200 тыс. долларов в год (условия Unity на момент установки нужно прочитать самому).

## 2. Шаги

1. Установить Unity Hub (в PowerShell):

   ```powershell
   winget install --id Unity.UnityHub -e
   ```

2. Открыть Unity Hub, войти через Unity ID (создать бесплатно, если нет) и активировать лицензию **Personal**
   (Hub → Preferences → Licenses → Add → Get a free personal license). Вход и принятие условий — только самим владельцем учётной записи.
3. Hub → Installs → Install Editor → вкладка «Official releases» → **Unity 6.3 (LTS)**, последний патч.
   Модули: оставить «Windows Build Support (Mono)» (по умолчанию). Visual Studio Community можно **снять** — для прототипа не нужна.
4. Сообщить в чат номер установленной версии (например, `6000.3.x`). Дальше всё делается из командной строки
   (`Unity.exe -batchmode -projectPath … -executeMethod …`): создание проекта, сцены, сборка, замеры.

## 3. Важное про пути

- Unity-проект будет лежать в `C:\Ashkerov\worldbound-unity\unity\` — путь **только латиницей**: у Unity бывают сбои
  с не-ASCII путями (основной проект лежит в `C:\Ashkerov\проекты\…`, поэтому для эксперимента — отдельная рабочая папка git).
- Папки `Library/`, `Temp/`, `Logs/`, `UserSettings/`, `Build/` в git не попадают (`.gitignore` Unity).

## 4. Память

На машине 8 ГБ. Редактор Unity занимает 2–4 ГБ; на время замеров стоит закрыть браузеры и тяжёлые приложения —
иначе встроенная графика Iris Xe (общая с системной памятью) проседает (на этапе 5 при свободных < 1 ГБ кадр рос до 260 мс).
Замеры производительности делаются на собранном приложении (`Build/`), а не в редакторе.
