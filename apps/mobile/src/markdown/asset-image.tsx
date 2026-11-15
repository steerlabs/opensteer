import { useContext, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useAssetImage } from "@opensteer/client/react";
import { color, radius } from "../theme.js";
import { ReferenceVisibility, useReferenceNavigation } from "./reference-context.js";

/**
 * An image an agent embedded. Nothing is asked of the Host until it can be
 * seen; until then it holds its place at the shape it will take. A tap opens
 * it in the file viewer, where Original and Download are.
 */
export function AssetImage({ path, alt = "" }: { path: string; alt?: string }) {
  const visible = useContext(ReferenceVisibility);
  const preview = useAssetImage(path, "preview", { enabled: visible });
  const navigation = useReferenceNavigation();
  const [open, setOpen] = useState(false);
  if (preview.failed) return <Text>{alt || "Image unavailable"}</Text>;
  if (!preview.available) return <Text>{alt || path}</Text>;
  const image = preview.image;
  const viewer =
    navigation?.ports !== undefined && "openFile" in navigation.ports ? navigation.ports : null;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={alt || "Open image"}
        onPress={() =>
          viewer ? void viewer.openFile({ source: { kind: "path", path } }) : setOpen(true)
        }
      >
        <Image
          key={preview.retry}
          source={
            image
              ? {
                  uri: image.source,
                  cacheKey: `${preview.deploymentId}:${image.revision}:preview:v1`,
                }
              : null
          }
          cachePolicy="memory-disk"
          contentFit="contain"
          accessibilityLabel={alt}
          style={[
            styles.image,
            {
              aspectRatio: image?.width && image.height ? image.width / image.height : 4 / 3,
            },
          ]}
          onError={preview.onError}
        />
      </Pressable>
      {open ? <OriginalImage path={path} close={() => setOpen(false)} /> : null}
    </View>
  );
}
function OriginalImage({ path, close }: { path: string; close: () => void }) {
  const original = useAssetImage(path, "original");
  const image = original.image;
  return (
    <Modal visible onRequestClose={close} animationType="fade">
      <View style={{ flex: 1, backgroundColor: "black", paddingVertical: 60 }}>
        <Pressable accessibilityRole="button" onPress={close}>
          <Text style={{ color: "white", padding: 16 }}>Close</Text>
        </Pressable>
        {original.failed ? (
          <Text style={{ color: "white" }}>Image unavailable</Text>
        ) : (
          <Image
            key={original.retry}
            source={
              image
                ? {
                    uri: image.source,
                    cacheKey: `${original.deploymentId}:${image.revision}:original:v1`,
                  }
                : null
            }
            cachePolicy="memory-disk"
            contentFit="contain"
            style={{ flex: 1 }}
            onError={original.onError}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // A bounded place held before the image's own shape is known.
  image: {
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.md,
    maxHeight: 420,
    width: "100%",
  },
});
