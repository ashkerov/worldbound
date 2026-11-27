// Ассет шейдеров рендера растительности. Лежит в проекте и упомянут сценой — шейдеры гарантированно попадают
// в сборку (без Shader.Find и Resources). Имя файла совпадает с именем класса (требование сериализации Unity).

using UnityEngine;

namespace Worldbound.FloraView
{
    [CreateAssetMenu(menuName = "WORLDBOUND/Flora Render Assets")]
    public sealed class FloraRenderAssets : ScriptableObject
    {
        public Shader Woody, Impostor, Grass;
    }
}
