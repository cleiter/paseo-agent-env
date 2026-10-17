import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import { z } from "zod";
import { ENV_RELOADED_KIND, ENV_RELOADED_VERSION } from "./shared/timeline";

const schema = z.object({ names: z.array(z.string()) });

function EnvReloaded({ item, theme }: PluginTimelineItemProps<z.output<typeof schema>>) {
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
      Environment changed ({item.data.names.join(", ")}). Agent reloaded with the new environment.
    </Text>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: ENV_RELOADED_KIND,
    version: ENV_RELOADED_VERSION,
    schema,
    Component: EnvReloaded,
  });
  return () => {};
}
