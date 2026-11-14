import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { useAssetImage } from "@opensteer/client/react";

export function AssetImage({ path, alt = "" }: { path: string; alt?: string }) {
  const preview = useAssetImage(path);
  const [open, setOpen] = useState(false);
  if (preview.failed) return <Text>Image unavailable</Text>;
  if (!preview.available) return <Text>{alt || path}</Text>;
  const image = preview.image;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={alt || "Open image"}
        onPress={() => setOpen(true)}
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
          style={{
            width: "100%",
            aspectRatio: image?.width && image.height ? image.width / image.height : 4 / 3,
          }}
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
