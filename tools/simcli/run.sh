#!/usr/bin/env bash
# Сборка ядра Worldbound.Sim + golden-проверок компилятором Roslyn из поставки Unity и запуск на .NET 6 (CoreCLR).
# Ничего не устанавливает: использует Unity Editor (UNITY_DATA). Запуск из корня репозитория.
set -e
UNITY_DATA="${UNITY_DATA:-/c/Program Files/Unity/Hub/Editor/6000.3.29f1/Editor/Data}"
DOTNET="$UNITY_DATA/NetCoreRuntime/dotnet.exe"
CSC="$UNITY_DATA/DotNetSdkRoslyn/csc.dll"
FW=$(ls -d "$UNITY_DATA"/NetCoreRuntime/shared/Microsoft.NETCore.App/* | head -1)
OUT=unity/WorldboundProto/Temp/simcli
mkdir -p "$OUT"
REFS=()
for f in "$FW"/System*.dll "$FW"/Microsoft.*.dll "$FW"/netstandard.dll "$FW"/mscorlib.dll; do
  case "$(basename "$f")" in *.Native.*) ;; *) REFS+=("-r:$(cygpath -w "$f")");; esac
done
SRC=$(find unity/WorldboundProto/Assets/Worldbound/Sim unity/WorldboundProto/Assets/Worldbound/SimTests tools/simcli -name '*.cs')
"$DOTNET" "$CSC" -nologo -noconfig -nostdlib -target:exe -optimize+ -langversion:9 -nullable:disable -out:"$OUT/simcli.dll" "${REFS[@]}" $SRC
VER=$(basename "$FW")
printf '{"runtimeOptions":{"tfm":"net6.0","framework":{"name":"Microsoft.NETCore.App","version":"%s"}}}' "$VER" > "$OUT/simcli.runtimeconfig.json"
"$DOTNET" "$OUT/simcli.dll" "$@"
