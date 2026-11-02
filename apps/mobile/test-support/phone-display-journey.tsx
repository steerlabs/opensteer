import "../src/runtime.js";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { canRespondToRequests, HttpHostClient } from "@opensteer/client/host";
import {
  decodeDisplayViewerFrame,
  DisplayViewerClientMessageSchema,
  DisplayViewerServerMessageSchema,
  hostApiVersionHeader,
} from "@opensteer/protocol";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { registerRootComponent } from "expo";
import { hideMenu } from "expo-dev-client";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { AppState, Platform, Text, View } from "react-native";
import { z } from "zod";
import { MacAppPreview, MacAppView } from "../src/computers/mac-app-view.js";
import { openReactNativeSocket } from "../src/platform/react-native-socket.js";

// Separate Metro entry for the device suite; the shipping entry never imports it.
const coordinator = `http://${Platform.OS === "android" ? "10.0.2.2" : "127.0.0.1"}:18766`;
const Configuration = z.object({
  origin: z.url(),
  headers: z.record(z.string(), z.string()),
  sessionId: z.string(),
  machineId: z.string(),
});
const Control = z.object({
  stage: z.enum(["tile", "full", "closed"]),
  revision: z.number(),
  epoch: z
    .number()
    .int()
    .min(hostApiVersion - 1)
    .max(hostApiVersion + 1)
    .default(hostApiVersion),
});
const Stack = createNativeStackNavigator();
async function event(type: string, details: unknown = null) {
  await fetch(`${coordinator}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, details, platform: Platform.OS, at: Date.now() }),
  });
}

function Journey() {
  useEffect(() => {
    // This entry owns startup instead of App, which normally hides the native splash.
    void SplashScreen.hideAsync();
    hideMenu();
  }, []);
  const [connection, setConnection] = useState<{
    client: HttpHostClient;
    target: { appKey: null; computerSessionId: string; machineId: string };
  } | null>(null);
  const [stage, setStage] = useState<"tile" | "full" | "closed">("tile");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      void event("app-state", { state });
    });
    return () => listener.remove();
  }, []);
  useEffect(() => {
    let disposed = false;
    let client: HttpHostClient | undefined;
    let revision = -1;
    let epoch = hostApiVersion;
    const start = async () => {
      const config = Configuration.parse(
        await (await fetch(`${coordinator}/configuration?platform=${Platform.OS}`)).json(),
      );
      async function load(version: number) {
        client?.dispose();
        const next = new HttpHostClient({
          baseUrl: config.origin,
          fetch: async (resource, init) => {
            const headers = new Headers(init?.headers);
            for (const [key, value] of Object.entries(config.headers)) headers.set(key, value);
            headers.set(hostApiVersionHeader, String(version));
            const path = String(resource);
            if (/computer\.view\.capture|computer\.session\.capture/u.test(path))
              await event("forbidden-capture", path);
            const response = await fetch(resource, { ...init, headers });
            if (version !== hostApiVersion && response.status === 400)
              await event("epoch-refusal", {
                version,
                status: response.status,
                body: await response.clone().json(),
              });
            return response;
          },
          webSocketFactory: (url) => {
            const socket = openReactNativeSocket(url, config.headers);
            if (new URL(url).pathname.endsWith("/display")) {
              socket.binaryType = "arraybuffer";
              let replayThrough = -1;
              let maxLive = 0;
              let maxBytes = 0;
              let acknowledged = 0;
              const pending = new Map<number, { bytes: number; live: boolean }>();
              const send = socket.send.bind(socket);
              socket.send = (data) => {
                if (typeof data === "string") {
                  const message = DisplayViewerClientMessageSchema.safeParse(JSON.parse(data));
                  if (message.success && message.data.type === "display.ack") {
                    const sequence = message.data.sequence;
                    for (const key of pending.keys()) if (key <= sequence) pending.delete(key);
                    acknowledged++;
                  }
                }
                send(data);
              };
              socket.addEventListener("message", ({ data }) => {
                try {
                  if (data instanceof ArrayBuffer) {
                    const frame = decodeDisplayViewerFrame(new Uint8Array(data));
                    pending.set(frame.header.sequence, {
                      bytes: data.byteLength,
                      live: frame.header.sequence > replayThrough,
                    });
                    maxLive = Math.max(
                      maxLive,
                      [...pending.values()].filter((entry) => entry.live).length,
                    );
                    maxBytes = Math.max(
                      maxBytes,
                      [...pending.values()].reduce((sum, entry) => sum + entry.bytes, 0),
                    );
                    void event("frame", {
                      source: { kind: "task-session", sessionId: config.sessionId },
                      header: frame.header,
                      bytes: frame.payload.byteLength,
                      ...(frame.header.key ? { payload: encodeBase64Url(frame.payload) } : {}),
                    });
                  } else if (typeof data === "string") {
                    const parsed = DisplayViewerServerMessageSchema.safeParse(JSON.parse(data));
                    if (parsed.success) {
                      if (parsed.data.type === "display.state") {
                        if (parsed.data.replayThrough !== undefined) {
                          replayThrough = parsed.data.replayThrough;
                          pending.clear();
                        } else if (!["starting", "live"].includes(parsed.data.state))
                          pending.clear();
                      }
                      void event("display-state", parsed.data);
                    }
                  }
                } catch (failure) {
                  void event("error", failure instanceof Error ? failure.message : String(failure));
                }
              });
              socket.addEventListener("close", ({ code, reason }) => {
                void event("display-close", { code, reason, maxLive, maxBytes, acknowledged });
              });
            }
            return socket;
          },
        });
        client = next;
        try {
          await next.load();
        } catch (failure) {
          if (version === hostApiVersion) throw failure;
          await event("epoch-load-error", {
            version,
            message: failure instanceof Error ? failure.message : String(failure),
          });
        }
        if (disposed) {
          next.dispose();
          return;
        }
        setConnection({
          client: next,
          target: {
            appKey: null,
            computerSessionId: config.sessionId,
            machineId: config.machineId,
          },
        });
        await event("loaded", {
          version,
          connected: canRespondToRequests(next.getSnapshot()),
          sessionId: config.sessionId,
          machineId: config.machineId,
        });
      }
      await load(epoch);
      while (!disposed) {
        // Expo can open onboarding after the root mounts, covering the decoder.
        hideMenu();
        const control = Control.parse(await (await fetch(`${coordinator}/control`)).json());
        if (revision !== control.revision) {
          revision = control.revision;
          setStage(control.stage);
          if (epoch !== control.epoch) {
            epoch = control.epoch;
            await load(epoch);
          }
          await event("stage", control);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    void start().catch((failure: unknown) => {
      const words = failure instanceof Error ? failure.message : String(failure);
      setError(words);
      void event("error", words);
    });
    return () => {
      disposed = true;
      client?.dispose();
    };
  }, []);
  return (
    <View style={{ flex: 1, backgroundColor: "black", paddingTop: 60, paddingBottom: 30 }}>
      {error ? <Text style={{ color: "red" }}>{error}</Text> : null}
      {connection ? (
        <NavigationContainer>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Display">
              {() =>
                stage === "closed" ? (
                  <View
                    key={stage}
                    onLayout={() => {
                      void event("layout", { stage });
                    }}
                    style={{ flex: 1, backgroundColor: "black" }}
                  />
                ) : stage === "full" ? (
                  <View
                    key={stage}
                    onLayout={() => {
                      void event("layout", { stage });
                    }}
                    style={{ flex: 1 }}
                  >
                    <MacAppView
                      active
                      destination={{
                        computerSessionId: connection.target.computerSessionId,
                        kind: "phone",
                        machineId: connection.target.machineId,
                      }}
                      hostClient={connection.client}
                      onTyping={() => undefined}
                    />
                  </View>
                ) : (
                  <View
                    key={stage}
                    onLayout={() => {
                      void event("layout", { stage });
                    }}
                    style={{ height: "70%", marginTop: 50 }}
                  >
                    <MacAppPreview
                      active
                      machineId={connection.target.machineId}
                      phone
                      source={{
                        kind: "task-session",
                        sessionId: connection.target.computerSessionId,
                      }}
                      appName="Display fixture"
                      label="Live phone tile"
                      hostClient={connection.client}
                      onPageSize={(size) => {
                        void event("decoded", size);
                      }}
                    />
                  </View>
                )
              }
            </Stack.Screen>
          </Stack.Navigator>
        </NavigationContainer>
      ) : null}
    </View>
  );
}
registerRootComponent(Journey);
