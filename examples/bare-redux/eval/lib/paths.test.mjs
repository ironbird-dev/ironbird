import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MATERIAL_FILES } from '../../scripts/lib/exercise.mjs';
import { ACCEPTANCE, CHECKLIST, MATERIALS, RESULTS, TASK_SHEET, exampleDir, exerciseDir, materialsDir, proxyGradeLayout, proxyHome, proxyLayout, proxySessionLayout } from './paths.mjs';

describe('the proxy layout', () => {
  it('keeps everything under the eval home in proxy/, beside the M3 eval', () => {
    expect(proxyHome({ IRONBIRD_EVAL_HOME: '/x' })).toBe('/x/proxy');
    expect(proxyLayout('/x/proxy')).toMatchObject({ template: '/x/proxy/template', docs: '/x/proxy/docs', sessions: '/x/proxy/sessions', grades: '/x/proxy/grades' });
    expect(proxySessionLayout('/x/proxy', 'proxy-1')).toMatchObject({ project: '/x/proxy/sessions/proxy-1/project', docs: '/x/proxy/sessions/proxy-1/docs', record: '/x/proxy/sessions/proxy-1/session.json' });
    expect(proxyGradeLayout('/x/proxy/grades', 'proxy-1')).toMatchObject({ session: '/x/proxy/grades/proxy-1/session', grade: '/x/proxy/grades/proxy-1/grade.json' });
  });

  it('names the four material files, as plan 4\'s generator does', () => {
    expect(MATERIALS).toEqual(['TASK.md', 'CHECKLIST.md', 'RESULTS.md', 'acceptance.yaml']);
    expect(MATERIALS).toEqual(MATERIAL_FILES);
  });

  it('points the material paths at the exercise/ sources, never at the generated copy', () => {
    expect(path.relative(exampleDir, materialsDir)).toBe('exercise');
    expect(path.relative(exampleDir, exerciseDir)).toBe('integration-exercise');
    expect([TASK_SHEET, CHECKLIST, RESULTS, ACCEPTANCE].map((file) => path.relative(exampleDir, file))).toEqual(['exercise/TASK.md', 'exercise/CHECKLIST.md', 'exercise/RESULTS.md', 'exercise/acceptance.yaml']);
  });
});
