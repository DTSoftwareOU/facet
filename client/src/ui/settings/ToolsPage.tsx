/**
 * Settings → Tools (port of Android's ToolScreens): web search, MCP servers, skills and YOLO mode.
 * Sub-pages use the settings detail id: "search", "mcp:add", "mcp:add:local", "mcp:<id>", "skill:new", "skill:<id>".
 */
import { Monitor, Rocket } from 'lucide-react';
import { useEffect, useLayoutEffect } from 'react';
import { getApp } from '../../app';
import { platform } from '../../platform';
import { YOLO_TOOL_ROUNDS } from '../../tools/registry';
import { Divider, Group, Row, SwitchRow } from '../components/primitives';
import { useLocalPrefs, useSyncedPrefs } from '../hooks';
import { ui } from '../nav';
import { McpServerPage } from './McpServerDetail';
import { McpAddPage, McpOverviewGroup } from './McpServers';
import type { PageProps } from './SettingsDialog';
import { SkillEditPage, SkillsOverviewGroup } from './SkillsSection';
import { SearchOverviewGroup, WebSearchPage } from './ToolsSearch';
import { ToolsStatus } from './ToolsShared';

/** Where the overview was scrolled to, so coming back from a sub-page returns there. */
let overviewScroll = 0;

/** Sub-pages open at the top; the overview comes back where it was. */
function useScrollPerDetail(detail: string | null) {
  useLayoutEffect(() => {
    const body = document.querySelector<HTMLElement>('.settings-dialog .settings-body');
    if (!body) return;
    body.scrollTop = detail ? 0 : overviewScroll;
    if (detail) return;
    return () => {
      overviewScroll = body.scrollTop;
    };
  }, [detail]);
  // Opening Tools again later starts at the top.
  useEffect(
    () => () => {
      overviewScroll = 0;
    },
    [],
  );
}

export function ToolsPage({ detail }: PageProps) {
  useScrollPerDetail(detail);
  if (detail === 'search') return <WebSearchPage />;
  if (detail === 'mcp:add') return <McpAddPage key="add" />;
  if (detail === 'mcp:add:local') return <McpAddPage key="add-local" local />;
  if (detail?.startsWith('mcp:')) return <McpServerPage key={detail} id={detail.slice(4)} />;
  if (detail === 'skill:new') return <SkillEditPage key="new" id={null} />;
  if (detail?.startsWith('skill:')) return <SkillEditPage key={detail} id={detail.slice(6)} />;
  return <ToolsOverview />;
}

function ToolsOverview() {
  const app = getApp();
  const synced = useSyncedPrefs();
  const local = useLocalPrefs();
  const computer = platform().computer;
  return (
    <div className="col gap-16 tools-page">
      <p className="settings-intro t-body" style={{ margin: '0 4px' }}>
        Tools let models search the web, use your apps through MCP servers and follow your skills. They work with any model that supports
        tools, and tools that change things ask before they run.
      </p>

      <SearchOverviewGroup />
      <McpOverviewGroup />
      <SkillsOverviewGroup />

      <Group title="Approvals">
        <SwitchRow
          icon={<Rocket size={20} />}
          title="YOLO mode"
          subtitle={`Run every tool call without asking, in every chat on all your devices, and allow up to ${YOLO_TOOL_ROUNDS} tool rounds per reply.`}
          checked={synced.yoloMode}
          onChange={(v) => void app.settings.updateSynced((s) => ({ ...s, yoloMode: v }))}
        />
        {computer && <Divider />}
        {computer && (
          <Row
            icon={<Monitor size={20} />}
            title="Computer access"
            subtitle={local.computerTools ? 'Commands and files in a chat’s working folder' : 'Off'}
            onClick={() => ui.openSettings('computer')}
          />
        )}
      </Group>
      {synced.yoloMode && (
        <ToolsStatus tone="warning">
          YOLO mode is on: every tool runs without asking, including tools that change files or data. Turn it off when you aren’t
          watching.
        </ToolsStatus>
      )}
    </div>
  );
}
