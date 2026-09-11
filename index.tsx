import type { GloomPlugin } from "gloomberb/types/plugin";
import { PollsPane } from "./pane";
import { POLLS_PANE_ID, POLLS_PLUGIN_ID } from "./types";

export const pollsPlugin: GloomPlugin = {
  id: POLLS_PLUGIN_ID,
  name: "Polls",
  version: "1.0.0",
  description: "Political polls from VoteHub (CC BY 4.0)",
  homepage: "https://github.com/gloom-sh/gloom-polls",
  toggleable: true,

  // Public JSON over HTTPS, so every renderer. VoteHub sends no CORS headers,
  // which is why the host is declared: the web app proxies it.
  targets: ["cli", "tui", "desktop", "web"],
  hosts: ["api.votehub.com"],

  panes: [
    {
      id: POLLS_PANE_ID,
      name: "Polls",
      icon: "P",
      component: PollsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 32 },
    },
  ],

  paneTemplates: [
    {
      id: "polls-pane",
      paneId: POLLS_PANE_ID,
      label: "Polls",
      description: "Browse VoteHub political polls by type — approval, favorability, generic ballot, Senate, governor, House — with trend charts, pollster breakdowns, search, and source links.",
      keywords: ["polls", "votehub", "approval", "favorability", "generic", "ballot", "senate", "governor"],
      shortcut: { prefix: "POLL" },
      createInstance: () => ({ placement: "floating" }),
    },
  ],
};

export default pollsPlugin;
