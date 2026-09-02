import { MODULE_ID } from '../constants.js';
import type { FoundryDataAccess } from '../data-access.js';
import {
  audit,
  checkAccess,
  constValue,
  registerNamespaceQueries,
  resolveActor,
  resolveScene,
  resolveUserIds,
  unknownAction,
} from './common.js';

/**
 * Combat and chat handlers. Both work purely on documents, so the canvas-less
 * bridge client can run a whole encounter and narrate it into the chat log.
 */

const COMBAT_ACTIONS = [
  'create',
  'add',
  'remove',
  'roll-initiative',
  'start',
  'next',
  'previous',
  'end',
  'status',
] as const;

const SELECT_MODES = ['all', 'hostile', 'friendly', 'npc', 'pc'] as const;

export class CombatChatHandlers {
  constructor(private dataAccess: FoundryDataAccess) {}

  registerHandlers(): void {
    registerNamespaceQueries('combat', COMBAT_ACTIONS, this.handleCombat.bind(this));
    CONFIG.queries[`${MODULE_ID}.chat.send`] = this.handleChatSend.bind(this);
  }

  // --- 5.1 manage-combat -----------------------------------------------------

  private async handleCombat(data: any): Promise<any> {
    const action = data?.action;
    const denied = checkAccess(action !== 'status');
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const scene = resolveScene(data?.scene);

    if (action === 'create') return await this.createCombat(scene, data);

    const combat = this.requireCombat(scene);

    switch (action) {
      case 'add':
        return await this.addCombatants(combat, scene, data);
      case 'remove':
        return await this.removeCombatants(combat, scene, data);
      case 'roll-initiative':
        return await this.rollInitiative(combat, data);
      case 'start':
        await combat.startCombat();
        audit(this.dataAccess, 'combat.start', { id: combat.id }, 'success');
        return CombatChatHandlers.combatStatus(combat);
      case 'next':
        await combat.nextTurn();
        return CombatChatHandlers.combatStatus(combat);
      case 'previous':
        await combat.previousTurn();
        return CombatChatHandlers.combatStatus(combat);
      case 'end':
        await combat.endCombat();
        audit(this.dataAccess, 'combat.end', { id: combat.id }, 'success');
        return { id: combat.id, ended: true };
      case 'status':
        return CombatChatHandlers.combatStatus(combat);
      default:
        throw unknownAction(action, COMBAT_ACTIONS);
    }
  }

  private async createCombat(scene: any, data: any): Promise<any> {
    const cls = (globalThis as any).Combat?.implementation ?? (globalThis as any).Combat;
    const combat = await cls.create({ scene: scene.id, active: true });
    if (!combat) throw new Error(`Could not create a combat for scene "${scene.name}"`);

    const tokens = CombatChatHandlers.selectTokens(scene, data);
    if (tokens.length > 0) {
      await combat.createEmbeddedDocuments(
        'Combatant',
        tokens.map(token => CombatChatHandlers.combatantData(token, scene))
      );
    }

    if (data?.rollAll === true) await combat.rollAll();
    else if (data?.rollNpc !== false) await combat.rollNPC();

    await this.applyInitiative(combat, data?.initiative);

    audit(
      this.dataAccess,
      'combat.create',
      { id: combat.id, sceneId: scene.id, combatants: tokens.length },
      'success'
    );

    return CombatChatHandlers.combatStatus(combat);
  }

  private async addCombatants(combat: any, scene: any, data: any): Promise<any> {
    const tokens = CombatChatHandlers.selectTokens(scene, data);
    const existing = new Set(
      Array.from(combat.combatants ?? [])
        .map((c: any) => c.tokenId)
        .filter(Boolean)
    );

    const payload = tokens
      .filter(token => !existing.has(token.id))
      .map(token => CombatChatHandlers.combatantData(token, scene));

    if (payload.length === 0) {
      return { id: combat.id, added: 0, note: 'Every selected token is already in the combat' };
    }

    const created = (await combat.createEmbeddedDocuments('Combatant', payload)) as any[];

    if (data?.rollAll === true) await combat.rollAll();
    else if (data?.rollNpc === true) await combat.rollNPC();

    await this.applyInitiative(combat, data?.initiative);

    audit(this.dataAccess, 'combat.add', { id: combat.id, count: created?.length ?? 0 }, 'success');

    return {
      id: combat.id,
      added: created?.length ?? 0,
      ...CombatChatHandlers.combatStatus(combat),
    };
  }

  private async removeCombatants(combat: any, scene: any, data: any): Promise<any> {
    const tokens = CombatChatHandlers.selectTokens(scene, data);
    const wanted = new Set(tokens.map(token => token.id));

    const ids = Array.from(combat.combatants ?? [])
      .filter((c: any) => wanted.has(c.tokenId))
      .map((c: any) => c.id);

    if (ids.length === 0) {
      return { id: combat.id, removed: 0, note: 'No matching combatants in this combat' };
    }

    const deleted = (await combat.deleteEmbeddedDocuments('Combatant', ids)) as any[];

    audit(
      this.dataAccess,
      'combat.remove',
      { id: combat.id, count: deleted?.length ?? 0 },
      'success'
    );

    return { id: combat.id, removed: deleted?.length ?? 0 };
  }

  private async rollInitiative(combat: any, data: any): Promise<any> {
    if (data?.initiative && typeof data.initiative === 'object') {
      await this.applyInitiative(combat, data.initiative);
      return CombatChatHandlers.combatStatus(combat);
    }

    if (data?.rollAll === true) {
      await combat.rollAll();
    } else if (Array.isArray(data?.tokens) && data.tokens.length > 0) {
      const wanted = new Set(
        data.tokens.map((identifier: string) => String(identifier).toLowerCase())
      );
      const ids = Array.from(combat.combatants ?? [])
        .filter(
          (c: any) =>
            wanted.has(String(c.tokenId).toLowerCase()) ||
            wanted.has(String(c.name ?? '').toLowerCase())
        )
        .map((c: any) => c.id);

      if (ids.length === 0) throw new Error('None of the given tokens are in this combat');
      await combat.rollInitiative(ids);
    } else {
      await combat.rollNPC();
    }

    audit(this.dataAccess, 'combat.roll-initiative', { id: combat.id }, 'success');

    return CombatChatHandlers.combatStatus(combat);
  }

  /** Write explicit initiative values, addressed by combatant name or token id. */
  private async applyInitiative(combat: any, initiative: any): Promise<void> {
    if (!initiative || typeof initiative !== 'object') return;

    for (const [key, value] of Object.entries(initiative)) {
      if (typeof value !== 'number') {
        throw new Error(`initiative["${key}"] must be a number`);
      }

      const needle = key.toLowerCase();
      const combatants: any[] = Array.from(combat.combatants ?? []);
      const match =
        combatants.find(c => c.id === key || c.tokenId === key) ??
        combatants.find(c => String(c.name ?? '').toLowerCase() === needle) ??
        combatants.find(c =>
          String(c.name ?? '')
            .toLowerCase()
            .includes(needle)
        );

      if (!match) throw new Error(`No combatant matching "${key}" in this combat`);
      await combat.setInitiative(match.id, value);
    }
  }

  /** The combat attached to a scene, preferring the scene's own over the active one. */
  private requireCombat(scene: any): any {
    const combats: any[] = Array.from((game as any).combats ?? []);
    const forScene = combats.filter(c => (c.scene?.id ?? c.scene) === scene.id);

    const combat =
      forScene.find(c => c.active === true) ??
      forScene[0] ??
      ((game as any).combat?.scene?.id === scene.id ? (game as any).combat : null);

    if (!combat) {
      throw new Error(
        `No combat exists for scene "${scene.name}" - run manage-combat with action "create" first`
      );
    }
    return combat;
  }

  private static combatantData(token: any, scene: any): Record<string, any> {
    return {
      tokenId: token.id,
      sceneId: scene.id,
      actorId: token.actorId ?? token.actor?.id ?? null,
      hidden: token.hidden === true,
    };
  }

  private static combatStatus(combat: any): Record<string, any> {
    const combatants: any[] = Array.from(combat.combatants ?? []);
    const currentId = combat.combatant?.id ?? null;

    return {
      id: combat.id,
      round: combat.round,
      turn: combat.turn,
      active: combat.active === true,
      started: combat.started === true,
      combatants: combatants.map(c => ({
        id: c.id,
        name: c.name,
        initiative: c.initiative ?? null,
        tokenId: c.tokenId ?? null,
        defeated: c.isDefeated === true || c.defeated === true,
        hidden: c.hidden === true,
        isCurrent: c.id === currentId,
      })),
    };
  }

  /** Pick the scene tokens a combat action applies to. */
  private static selectTokens(scene: any, data: any): any[] {
    const tokens: any[] = Array.from(scene.tokens ?? []);

    if (Array.isArray(data?.tokens) && data.tokens.length > 0) {
      return data.tokens.map((identifier: string) =>
        CombatChatHandlers.findToken(scene, identifier)
      );
    }

    const select = data?.select ?? 'all';
    switch (select) {
      case 'all':
        return tokens;
      case 'hostile':
        return tokens.filter(t => t.disposition === constValue('TOKEN_DISPOSITIONS.HOSTILE', -1));
      case 'friendly':
        return tokens.filter(t => t.disposition === constValue('TOKEN_DISPOSITIONS.FRIENDLY', 1));
      case 'npc':
        return tokens.filter(t => !CombatChatHandlers.isPlayerToken(t));
      case 'pc':
        return tokens.filter(t => CombatChatHandlers.isPlayerToken(t));
      default:
        throw new Error(`Unknown select "${String(select)}". Valid: ${SELECT_MODES.join(', ')}`);
    }
  }

  private static isPlayerToken(token: any): boolean {
    return token?.actor?.hasPlayerOwner === true || token?.actor?.type === 'character';
  }

  /** Find a token on a scene by id, exact name or case-insensitive partial name. */
  private static findToken(scene: any, identifier: string): any {
    if (typeof identifier !== 'string' || identifier.trim().length === 0) {
      throw new Error('token identifiers must be non-empty strings');
    }

    const tokens: any[] = Array.from(scene.tokens ?? []);
    const byId = tokens.find(token => token.id === identifier);
    if (byId) return byId;

    const exact = tokens.filter(token => token.name === identifier);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return exact[0];

    const needle = identifier.toLowerCase();
    const partial = tokens.filter(
      token => typeof token.name === 'string' && token.name.toLowerCase().includes(needle)
    );
    if (partial.length >= 1) return partial[0];

    throw new Error(`Token "${identifier}" not found on scene "${scene.name}"`);
  }

  // --- 5.2 send-chat ---------------------------------------------------------

  private async handleChatSend(data: any): Promise<any> {
    const denied = checkAccess(true);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const message = data?.message;
    const formula = data?.roll;
    const hasMessage = typeof message === 'string' && message.trim().length > 0;

    if (!hasMessage && typeof formula !== 'string') {
      throw new Error('message (HTML) or roll (a dice formula) is required');
    }

    const speaker = await this.buildSpeaker(data?.speaker);
    const style = CombatChatHandlers.styleValue(data?.style, Boolean(data?.speaker));
    const whisper = CombatChatHandlers.resolveWhisper(data?.whisperTo);

    let content = hasMessage ? message : '';
    if (typeof data?.image === 'string' && data.image.trim().length > 0) {
      content += `<img src="${data.image}" alt="" style="max-width:100%;" />`;
    }

    const messageData: Record<string, any> = { speaker, style };
    if (typeof data?.flavor === 'string' && data.flavor.length > 0)
      messageData.flavor = data.flavor;
    if (whisper) messageData.whisper = whisper;

    let created: any;

    if (typeof formula === 'string' && formula.trim().length > 0) {
      const RollCls = (globalThis as any).Roll;
      if (typeof RollCls !== 'function') {
        throw new Error('The Roll class is unavailable in this Foundry build');
      }

      const roll = new RollCls(formula);
      await roll.evaluate();

      // A message given alongside a formula becomes the roll's label
      if (!messageData.flavor && content.length > 0) messageData.flavor = content;

      created = await roll.toMessage(messageData, { create: true });
    } else {
      const cls =
        (globalThis as any).ChatMessage?.implementation ?? (globalThis as any).ChatMessage;
      created = await cls.create({ ...messageData, content });
    }

    if (!created) throw new Error('Foundry returned no chat message');

    audit(
      this.dataAccess,
      'chat.send',
      { id: created.id, whispered: Boolean(whisper), roll: Boolean(formula) },
      'success'
    );

    return { id: created.id, uuid: created.uuid ?? null, whisper: whisper ?? [] };
  }

  /** Build a speaker from a token name on the active scene, else from an actor. */
  private async buildSpeaker(identifier: unknown): Promise<Record<string, any>> {
    const cls = (globalThis as any).ChatMessage?.implementation ?? (globalThis as any).ChatMessage;

    if (typeof identifier !== 'string' || identifier.trim().length === 0) {
      return cls.getSpeaker({});
    }

    const scenes = (game as any).scenes;
    const scene = scenes?.active ?? scenes?.current ?? null;

    if (scene) {
      const tokens: any[] = Array.from(scene.tokens ?? []);
      const needle = identifier.toLowerCase();
      const token =
        tokens.find(t => t.id === identifier) ??
        tokens.find(t => t.name === identifier) ??
        tokens.find(t => typeof t.name === 'string' && t.name.toLowerCase().includes(needle));

      if (token) return cls.getSpeaker({ token, scene });
    }

    const actor = await resolveActor(identifier);
    return cls.getSpeaker({ actor });
  }

  private static styleValue(word: unknown, hasSpeaker: boolean): number {
    const key = String(word ?? (hasSpeaker ? 'ic' : 'other')).toLowerCase();
    switch (key) {
      case 'ic':
        return constValue('CHAT_MESSAGE_STYLES.IC', 2);
      case 'ooc':
        return constValue('CHAT_MESSAGE_STYLES.OOC', 1);
      case 'emote':
        return constValue('CHAT_MESSAGE_STYLES.EMOTE', 3);
      case 'other':
        return constValue('CHAT_MESSAGE_STYLES.OTHER', 0);
      default:
        throw new Error(`Unknown style "${String(word)}". Valid: ic, ooc, emote, other`);
    }
  }

  /** Turn `whisperTo` into user ids; "gm" covers every GM in the world. */
  private static resolveWhisper(spec: unknown): string[] | null {
    if (spec === undefined || spec === null) return null;

    if (typeof spec === 'string' && spec.toLowerCase() === 'gm') {
      const cls =
        (globalThis as any).ChatMessage?.implementation ?? (globalThis as any).ChatMessage;
      if (typeof cls?.getWhisperRecipients === 'function') {
        const recipients: any[] = cls.getWhisperRecipients('GM') ?? [];
        if (recipients.length > 0) return recipients.map(user => user.id ?? user);
      }
      const all: any[] = Array.from((game as any).users ?? []);
      return all.filter(user => user?.isGM === true).map(user => user.id);
    }

    if (Array.isArray(spec) && spec.length === 0) return null;

    return resolveUserIds(spec as string[]);
  }
}
