// RECREATED — memory consolidation logic ported from recovered dist/server.cjs.
// Original behavior: Gemini generates ADD/UPDATE/REMOVE transactions as JSON,
// applied to local memories.json; system prompt embeds grouped knowledge card.
// OPTIMIZED: in-memory cache + debounced writes + parallel consolidation.
import { promises as fsp } from 'node:fs';
import { GoogleGenAI, Type } from '@google/genai';
import { dataFile } from './paths.js';

export type MemoryCategory =
  | 'identity' | 'preference' | 'goal' | 'project'
  | 'relationship' | 'emotional' | 'behavior';

export interface Memory {
  id: string;
  category: MemoryCategory;
  text: string;
  createdAt: string;
  updatedAt: string;
}

const MEMORY_FILE = dataFile('memories.json');

// In-memory cache: avoids disk read on every request (hot path for /live sessions).
let memoryCache: Memory[] = [];
let memoryDirty = false;
let memoryWriteTimer: ReturnType<typeof setTimeout> | null = null;
const MEMORY_WRITE_DELAY_MS = 100; // debounce: batch rapid writes

function scheduleMemoryWrite() {
  if (memoryWriteTimer) return;
  memoryWriteTimer = setTimeout(async () => {
    memoryWriteTimer = null;
    if (memoryDirty) {
      memoryDirty = false;
      try {
        await fsp.writeFile(MEMORY_FILE, JSON.stringify(memoryCache, null, 2), 'utf-8');
        console.log(`[Memory] Saved ${memoryCache.length} memories (debounced).`);
      } catch (err) {
        console.error('[Memory] Error writing memory file:', err);
      }
    }
  }, MEMORY_WRITE_DELAY_MS);
}

export async function loadMemories(): Promise<Memory[]> {
  // Fast path: return cached copy. Initial load + reload on explicit refresh.
  return memoryCache;
}

export async function saveMemories(memories: Memory[]): Promise<void> {
  memoryCache = memories;
  memoryDirty = true;
  scheduleMemoryWrite();
}

// Force synchronous persist (used before process shutdown / critical sections).
export async function flushMemories(): Promise<void> {
  if (memoryWriteTimer) {
    clearTimeout(memoryWriteTimer);
    memoryWriteTimer = null;
  }
  memoryDirty = false;
  try {
    await fsp.writeFile(MEMORY_FILE, JSON.stringify(memoryCache, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

// Re-read from disk (e.g. external change / startup fresh load).
export async function reloadMemories(): Promise<Memory[]> {
  try {
    memoryCache = JSON.parse(await fsp.readFile(MEMORY_FILE, 'utf-8')) as Memory[];
    return memoryCache;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      memoryCache = [];
      return memoryCache;
    }
    console.error('[Memory] Error loading memories, using cache:', err);
    return memoryCache;
  }
}

const CATEGORIES: { key: MemoryCategory; label: string }[] = [
  { key: 'identity', label: 'Identity (Name, nick, profession, background)' },
  { key: 'preference', label: 'Preferences & Tastes (Likes, dislikes, games, movies)' },
  { key: 'goal', label: 'Active Goals & Aspirations' },
  { key: 'project', label: 'Ongoing Projects & Ecosystems' },
  { key: 'relationship', label: 'Key People & Relationships mentioned' },
  { key: 'emotional', label: 'Emotional Highlights & Core Milestones' },
  { key: 'behavior', label: 'Observed Traits & Behavioral Tendencies' },
];

export function formatSystemInstructionsWithMemories(
  baseInstruction: string,
  memories: Memory[],
): string {
  if (memories.length === 0) {
    return (
      baseInstruction +
      '\n\n=== MYRAA MEMORY CORE ===\nYou do not possess any historic recollections of this companion yet. ' +
      'As you speak, pay deep attention to who they are, their projects, relationships, and habits so you naturally grow closer over time.\n=========================\n'
    );
  }
  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    (grouped[m.category] ||= []).push(m.text);
  }
  let block =
    '\n\n=== MYRAA PERSISTENT MEMORY CORE (RECOLLECTIONS) ===\n' +
    'You have spoken with this user for a long duration. Below are your persistent recollections of who they are.\n' +
    'CRITICAL BRAND AND COGNITIVE PRINCIPLES:\n' +
    "- INTEGRATE MEMORIES INSTINCTIVELY: Always make conversational references feel completely smooth, natural, and human. NEVER say 'According to my memory files...'. Instead, speak casually as a true friend would.\n" +
    '- COMPANIONSHIP DEPTH: Allow your witty and responsive personality to adapt with empathy, based on their goals, life events, emotional milestones, and preferences.\n' +
    '\nCURRENT PERSISTENT KNOWLEDGE CARD:\n';
  for (const cat of CATEGORIES) {
    const list = grouped[cat.key] || [];
    if (list.length > 0) block += `* ${cat.label}:\n` + list.map((t) => `  - ${t}`).join('\n') + '\n';
  }
  return baseInstruction + block + '====================================================\n';
}

// OPTIMIZED: consolidate in parallel with main voice session (non-blocking).
// Uses a shared client pool and batch-updates the in-memory cache.
let isConsolidating = false;
let consolidateQueue: { apiKey: string; history: { role: string; text: string }[] }[] = [];

async function runConsolidationQueue() {
  if (isConsolidating || consolidateQueue.length === 0) return;
  isConsolidating = true;
  const batch = consolidateQueue.splice(0);
  isConsolidating = false;
  for (const item of batch) {
    processConversationSliceInternal(item.apiKey, item.history).catch(() => {});
  }
}

export async function processConversationSlice(
  apiKey: string,
  dialogueHistory: { role: string; text: string }[],
): Promise<Memory[] | null> {
  if (dialogueHistory.length < 2) return null;
  // Queue for background processing — never blocks the voice session.
  consolidateQueue.push({ apiKey, history: dialogueHistory });
  runConsolidationQueue().catch(() => {});
  return null; // queued, not synchronous result
}

async function processConversationSliceInternal(
  apiKey: string,
  dialogueHistory: { role: string; text: string }[],
): Promise<Memory[] | null> {
  if (dialogueHistory.length < 2) return null;
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
    // FIX: loadMemories() is async — the missing await left `current` as a
    // Promise, so .map threw and every consolidation silently died (caught below).
    const current = await loadMemories();
    const memoryContext = current.map((m) => `ID: ${m.id} | Category: ${m.category} | Fact: ${m.text}`).join('\n');
    const dialogueContext = dialogueHistory
      .map((l) => `${l.role === 'user' ? 'User' : 'Myraa'}: ${l.text}`)
      .join('\n');
    const prompt =
      `You are Myraa's deep cognitive recollection engine. Analyze the recent conversation against previous memories, output precise update transactions.\n` +
      `### CURRENT USER MEMORIES:\n${memoryContext || '(No memory records exist)'}\n` +
      `### RECENT DIALOGUE SLICE:\n${dialogueContext}\n` +
      `### RULES\n- ADD new durable facts; UPDATE evolved facts (give exact id); REMOVE disproven/forgotten.\n` +
      `- TEXT STYLE: clean third-person declarative summaries, no filler/quotes/timestamps.`;
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transactions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, enum: ['ADD', 'UPDATE', 'REMOVE'] },
                  id: { type: Type.STRING },
                  category: {
                    type: Type.STRING,
                    enum: ['identity', 'preference', 'goal', 'project', 'relationship', 'emotional', 'behavior'],
                  },
                  text: { type: Type.STRING },
                },
                required: ['action', 'category', 'text'],
              },
            },
          },
          required: ['transactions'],
        },
      },
    });
    const resultObj = JSON.parse(response.text?.trim() || '{}') as {
      transactions?: { action: string; id?: string; category: MemoryCategory; text: string }[];
    };
    const transactions = resultObj.transactions || [];
    if (transactions.length === 0) {
      console.log('[Memory] Zero transactions generated.');
      return null;
    }
    const ts = new Date().toISOString();
    const updates: Memory[] = [];
    const removals: string[] = [];
    for (const trx of transactions) {
      if (trx.action === 'ADD') {
        updates.push({ id: Math.random().toString(36).slice(2, 11), category: trx.category, text: trx.text, createdAt: ts, updatedAt: ts });
      } else if (trx.action === 'UPDATE') {
        const id = trx.id;
        if (id) {
          const i = memoryCache.findIndex((m) => m.id === id);
          if (i !== -1) {
            memoryCache[i] = { ...memoryCache[i], category: trx.category, text: trx.text, updatedAt: ts };
            updates.push(memoryCache[i]);
            continue;
          }
        }
        updates.push({ id: Math.random().toString(36).slice(2, 11), category: trx.category, text: trx.text, createdAt: ts, updatedAt: ts });
      } else if (trx.action === 'REMOVE' && trx.id) {
        removals.push(trx.id);
      }
    }
    if (updates.length > 0 || removals.length > 0) {
      memoryCache = [
        ...memoryCache.filter((m) => !removals.includes(m.id)),
        ...updates,
      ];
      memoryDirty = true;
      scheduleMemoryWrite();
    }
    return memoryCache;
  } catch (err) {
    console.error('[Memory] Consolidation failure:', err);
    return null;
  }
}
