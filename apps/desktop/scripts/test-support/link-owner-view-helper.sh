#!/usr/bin/env bash
# Links the OwnerViewHelper fixture against the built ComputerUseCore, OpensteerAppleData
# and MacOSSigning objects: proof the owner-view surface compiles and links
# outside the helper app. --dependencies <directory> exports the SwiftPM-built
# dependency modules and archives for fixtures that compile the core as source. Usage (from apps/desktop): link-owner-view-helper.sh <output>
set -euo pipefail

dependencies=false
if [[ "$1" == --dependencies ]]; then dependencies=true; shift; fi
output=$1
package=native/computer-use
pnpm build:computer-use-helper --requirement-only
swift build -j 2 --package-path "$package"
bin=$(swift build -j 2 --package-path "$package" --show-bin-path)

# SwiftPM's native build system keeps each target's objects and the modules in
# the bin directory. Swift Build (the default from Swift 6.3) keeps the modules
# there and the objects under Intermediates.noindex beside Products, per
# configuration; another configuration's objects may sit there too, so only
# this one's are linked.
objects=()
if [[ -d "$bin/Modules" ]]; then modules="$bin/Modules"; else modules="$bin"; fi
configuration=$(basename "$bin")
for target in ComputerUseCore OpensteerAppleData MacOSSigning; do
  if [[ -d "$bin/Modules" ]]; then
    target_objects=("$bin/$target.build"/*.o)
  else
    directories=("$bin"/../../Intermediates.noindex/*/"$configuration/$target-t.build"/Objects-normal/*)
    if [[ ${#directories[@]} -ne 1 || ! -d "${directories[0]}" ]]; then
      echo "Expected one $configuration object directory for $target" >&2
      exit 1
    fi
    target_objects=("${directories[0]}"/*.o)
  fi
  if $dependencies; then
    if [[ "$target" != ComputerUseCore ]]; then
      cp -R "$modules/$target.swiftmodule" "$output/"
      /usr/bin/libtool -static -o "$output/lib$target.a" "${target_objects[@]}"
    fi
  else
    objects+=("${target_objects[@]}")
  fi
done
if $dependencies; then exit 0; fi
echo "modules=$modules objects=${#objects[@]}"
xcrun swiftc -I "$modules" "$package/Tests/Fixtures/OwnerViewHelper/OwnerViewHelper.swift" \
  "${objects[@]}" -o "$output"
