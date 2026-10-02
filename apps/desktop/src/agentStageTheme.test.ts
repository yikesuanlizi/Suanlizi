import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('agent stage dark theme', () => {
  it('keeps status-specific child agent cards on dark surfaces', () => {
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');
    const darkStart = styles.indexOf('/* ── Suanlizi desktop workspace skin');
    const darkStyles = styles.slice(darkStart);

    for (const tone of ['running', 'success', 'warning', 'danger']) {
      const selector = `.agentStageCard.${tone} {`;
      const blockStart = darkStyles.indexOf(selector);
      const block = darkStyles.slice(blockStart, darkStyles.indexOf('}', blockStart));

      expect(blockStart).toBeGreaterThan(-1);
      expect(block).toContain('background:');
      expect(block).toContain('#121519');
    }
  });

  it('uses semantic workbench surfaces while retaining the original animated robot', () => {
    const styles = readFileSync(join(here, 'styles.css'), 'utf-8');
    const stageSource = readFileSync(join(here, 'components', 'AgentStagePanel.tsx'), 'utf-8');
    const finalContract = styles.slice(styles.lastIndexOf('/* Suanlizi workbench surface contract */'));

    expect(stageSource).toContain('RobotMoodIcon');
    expect(stageSource).toContain('InteractiveMainRobot');
    expect(finalContract).toContain('.appShell .workbenchPane');
    expect(finalContract).toContain('.appShell .agentStageAvatarCard');
    expect(finalContract).toContain('background: var(--nx-surface-panel);');
  });
});
