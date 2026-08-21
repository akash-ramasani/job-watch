// ai.mjs — OpenAI client for the worker. Uses gpt-4o-mini (cheap). Reads
// OPENAI_API_KEY from the environment (worker/.env). Every text answer is run
// through the plain-style sanitizer so no em dash / colon / AI phrasing can slip
// into a submitted application.

import OpenAI from "openai";
import { sanitizeText, sanitizeBlock, STYLE_PROMPT } from "./style.mjs";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

let _client;
function client() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set (put it in worker/.env)");
  return (_client ||= new OpenAI({ apiKey: key }));
}

/** Low-level chat call. Returns raw string content. */
export async function chat(system, user, { maxTokens = 500, temperature = 0.5 } = {}) {
  const res = await client().chat.completions.create({
    model: MODEL,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices?.[0]?.message?.content?.trim() || "";
}

/** Answer a single free-text application question in plain style.
 *  Returns a sanitized short answer, or null if the model declines / is unsure. */
export async function answerFreeText(question, ctx) {
  const system = `You are filling a job application as the candidate. ${STYLE_PROMPT} Answer in first person. Keep it to two or three short sentences. If you do not have enough real information to answer honestly, reply with exactly NEEDS_REVIEW.`;
  const user = [
    `Candidate: ${ctx.name}`,
    ctx.currentTitle ? `Current role: ${ctx.currentTitle}` : "",
    ctx.skills ? `Skills: ${ctx.skills}` : "",
    ctx.summary ? `Summary: ${ctx.summary}` : "",
    `Job: ${ctx.jobTitle} at ${ctx.companyName}`,
    "",
    `Question: ${question}`,
  ].filter(Boolean).join("\n");

  const raw = await chat(system, user, { maxTokens: 160, temperature: 0.4 });
  if (!raw || /NEEDS_REVIEW/i.test(raw)) return null;
  const clean = sanitizeText(raw);
  return clean || null;
}

/** Generate a plain, human cover letter (sanitized, multi-paragraph). */
export async function coverLetter(ctx) {
  const system = `You write short plain cover letters as the candidate. ${STYLE_PROMPT} Three short paragraphs. First paragraph, why you want this job. Second, one or two real things from your experience that fit. Third, a short close. Do not invent facts.`;
  const user = [
    `Candidate: ${ctx.name}`,
    ctx.currentTitle ? `Current role: ${ctx.currentTitle}` : "",
    ctx.experience ? `Experience: ${ctx.experience}` : "",
    ctx.skills ? `Skills: ${ctx.skills}` : "",
    ctx.summary ? `Summary: ${ctx.summary}` : "",
    "",
    `Job: ${ctx.jobTitle} at ${ctx.companyName}`,
    ctx.jobDescription ? `Job description: ${ctx.jobDescription.slice(0, 1500)}` : "",
  ].filter(Boolean).join("\n");

  const raw = await chat(system, user, { maxTokens: 380, temperature: 0.6 });
  return sanitizeBlock(raw);
}

/** Tailor the resume summary + pick the most relevant skills/bullets for a job.
 *  Returns { summary, skills[], bullets[] } — all sanitized plain text.
 *  Only reorders and rephrases REAL resume content; never invents. */
export async function tailorResume(ctx) {
  const system = `You tailor a resume to a job by choosing and rephrasing the candidate's real experience. ${STYLE_PROMPT} Never invent facts. Only use what is given.`;
  const user = [
    `Job: ${ctx.jobTitle} at ${ctx.companyName}`,
    ctx.jobDescription ? `Job description: ${ctx.jobDescription.slice(0, 1200)}` : "",
    "",
    `Candidate summary: ${ctx.summary || ""}`,
    `All skills: ${ctx.allSkills || ""}`,
    `Experience bullets: ${(ctx.bullets || []).join(" | ")}`,
    "",
    "Return JSON with keys: summary (one short sentence), skills (array of the 12 most relevant skills from the list), bullets (array of the 6 most relevant experience bullets, rephrased plainly).",
  ].join("\n");

  const raw = await chat(system, user, { maxTokens: 700, temperature: 0.4 });
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ""));
  } catch {
    return null; // caller falls back to the untailored resume
  }
  return {
    summary: sanitizeText(parsed.summary || ctx.summary || ""),
    skills: (parsed.skills || []).map((s) => sanitizeText(String(s)).replace(/\.$/, "")).filter(Boolean),
    bullets: (parsed.bullets || []).map((b) => sanitizeText(String(b))).filter(Boolean),
  };
}
