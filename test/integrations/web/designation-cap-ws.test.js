import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { createFakeWs } from '../../helpers/mocks.js';

const require = createRequire(import.meta.url);
const createMessageHandler = require('../../../src/integrations/web/ws-handlers.js');

/**
 * The seam between the designation dialog and the model.
 *
 * sessionCap is threaded through designationDef:set and :update. If the handler
 * dropped it, every other test in this change would still pass — the model
 * stores what it is given and the queue enforces what it is stored — and the
 * cap would simply never arrive. So the forwarding itself is what these assert.
 *
 * The distinction that matters most is undefined vs null. setDesignationDef
 * rebuilds the def from scratch and deliberately PRESERVES an absent cap, so
 * that an agent calling designationDef:set with only name/description/colour
 * cannot silently uncap a lane. That only holds if the handler passes a missing
 * field through as undefined rather than normalising it to null or 0.
 */
describe('designation cap over the WebSocket', () => {
  let taskQueue, handle, ws;

  beforeEach(() => {
    taskQueue = {
      setDesignationDef: vi.fn(),
      renameDesignationDef: vi.fn().mockReturnValue(true),
    };
    handle = createMessageHandler({
      taskQueue,
      checkPermission: () => true,
      broadcast: () => {},
    });
    ws = createFakeWs();
  });

  const capArg = () => taskQueue.setDesignationDef.mock.calls.at(-1)[1];

  it('forwards a cap when a designation is saved', async () => {
    await handle(
      ws,
      {
        type: 'designationDef:set',
        name: 'Code Review',
        description: 'PR review work',
        color: 'purple',
        agentFiles: [],
        sessionCap: 5,
      },
      { login: 'jeff' },
    );

    expect(taskQueue.setDesignationDef).toHaveBeenCalled();
    expect(capArg().sessionCap).toBe(5);
  });

  it('forwards a cap of 0, which is a real setting and not an absent one', async () => {
    await handle(
      ws,
      {
        type: 'designationDef:set',
        name: 'Manual QA',
        sessionCap: 0,
      },
      { login: 'jeff' },
    );

    expect(capArg().sessionCap).toBe(0);
  });

  it('forwards null so a cap can be cleared', async () => {
    await handle(
      ws,
      {
        type: 'designationDef:update',
        name: 'Code Review',
        sessionCap: null,
      },
      { login: 'jeff' },
    );

    expect(capArg().sessionCap).toBeNull();
  });

  // The one that protects the preserve-on-absent rule in setDesignationDef.
  // Normalising this to null or 0 here would turn every agent-driven def
  // update into a silent uncapping.
  it('passes a missing cap through as undefined, not as a cleared one', async () => {
    await handle(
      ws,
      {
        type: 'designationDef:set',
        name: 'Code Review',
        description: 'PR review work',
        color: 'purple',
        agentFiles: [],
      },
      { login: 'jeff' },
    );

    expect(capArg().sessionCap).toBeUndefined();
    expect(capArg()).not.toHaveProperty('sessionCap', null);
  });

  it('keeps the cap when the designation is renamed in the same message', async () => {
    await handle(
      ws,
      {
        type: 'designationDef:update',
        oldName: 'Code Review',
        name: 'PR Review',
        sessionCap: 5,
      },
      { login: 'jeff' },
    );

    expect(taskQueue.renameDesignationDef).toHaveBeenCalledWith('Code Review', 'PR Review');
    expect(taskQueue.setDesignationDef).toHaveBeenCalled();
    expect(taskQueue.setDesignationDef.mock.calls.at(-1)[0]).toBe('PR Review');
    expect(capArg().sessionCap).toBe(5);
  });

  it('does not write the cap when the rename it depends on fails', async () => {
    taskQueue.renameDesignationDef.mockReturnValue(false);

    await handle(
      ws,
      {
        type: 'designationDef:update',
        oldName: 'Code Review',
        name: 'Manual QA',
        sessionCap: 5,
      },
      { login: 'jeff' },
    );

    // Writing here would put Code Review's cap onto the designation that
    // already owned the target name.
    expect(taskQueue.setDesignationDef).not.toHaveBeenCalled();
  });
});
