// Everything the fairy says on her own: idle motivation, reactions to statuses, specialty phrases.
// Functions (not constants) because the wording follows the current user's grammatical gender.

import { gv, gender } from "../data/user.js";
import { statusLabel } from "../data/statuses.js";

export function motivPhrases() {
  return ["Ти обкладинка цього дня ✦ " + gv("гарна й помітна", "гарний і помітний", "гарні й помітні") + "!", "Все буде Україна — і оффер твій буде теж ✦", "Кожне «" + statusLabel("applied", gender()).toLowerCase() + "» наближає твоє «вітаємо» ✦", "Пиши листи, як мемчики — з душею ✦", "Ти ходячий бренд-бук ✦", "Рекрутери ще не знають, як їм пощастило ✦", "Тримайся ✦ навіть Figma лагала, а ти ні!", "Хто рано подається, тому оффер усміхається ✦", "Ти в списку «мушу взяти», вони ще не знають ✦", "Спокійно, все під контролем, як шари у файлі ✦"];
}

// for guests and for an unknown specialty
export function motivGeneric() {
  return ["Ти ближче до мрії, ніж думаєш ✦", "Один відгук на день — і все зміниться ✦", "Вір у себе ✦ я вірю в тебе!", "Кожне «ні» наближає твоє «так» ✦", "Ти вже молодець, що " + gv("почала", "почав", "почали") + " ✦"];
}

// reactions keyed by status key
export function statusMessages() {
  const zrobyv = gv("зробила", "зробив", "зробили");
  const krut = gv("крута", "крутий", "круті");
  return {
    applied: ["Заявку відправлено ✦ пишаюся тобою!", "Полетіло! Ти " + zrobyv + " крок ✦"],
    interview1: ["Співбесіда!! Вони хочуть тебе бачити ✦ ти сяєш!", "Перший раунд — покажи клас ✦"],
    test: ["Тестове? Твоя стихія ✦ жени!", "Покажи, що вмієш ✦ я вірю!"],
    interview2: ["Другий раунд ✦ ти проходиш далі!", "Вже майже свої ✦ тримай темп!"],
    interview3: ["Третя співбесіда ✦ вони серйозно закохані!", "Ще трішки — і оффер твій ✦"],
    offer: ["ОФФЕР!!! ✦✦✦ Я так і знала! Танцюємо!", "Ти " + zrobyv + " це ✦ найкраща новина дня!", "Вітаю, зіронько ✦ це твоя перемога!"],
    reject: ["Не сумуй ✦ це не твої люди. Твої попереду!", "Їхня втрата ✦ ти надто " + krut + ".", "Одні двері зачинились — я вже шукаю наступні ✦ обійму."],
  };
}

// specialty: keywords found in a CV or vacancy, plus phrases tailored to it
export const SPECIALTIES = [
  { key: "design", kw: ["дизайн", "design", "figma", "photoshop", "illustrator", "brand", "typography", "ui/ux", "ux", "ui", "графіч", "ілюстра"], phr: ["Твоє портфоліо — це вже магія ✦ покажи його світу!", "Кожен піксель на своєму місці ✦ рекрутери це помітять!", "Фахівці твого рівня — рідкість ✦ не занижуй ставку!"] },
  { key: "dev", kw: ["developer", "розробник", "програміст", "javascript", "python", "react", "java", "backend", "frontend", "code", "код", "engineer"], phr: ["Твій код — поезія ✦ пиши сміливі відгуки!", "Один рефактор за раз ✦ і оффер твій!", "Технічна співбесіда? Ти ж це любиш ✦"] },
  { key: "marketing", kw: ["marketing", "маркет", "smm", "реклам", "targeting", "seo", "контент", "бренд-менеджер"], phr: ["Ти вмієш продати будь-що ✦ продай і себе!", "Твоя воронка веде прямо до оффера ✦", "Engagement росте, як і твої шанси ✦"] },
  { key: "pm", kw: ["project manager", "product manager", "проєктн", "продукт", "scrum", "agile", "менеджер проєкт"], phr: ["Ти керуєш хаосом ✦ керуй і своїм пошуком!", "Дедлайн на оффер? Виставляю ✦", "Твій roadmap веде до омріяної ролі ✦"] },
  { key: "music", kw: ["музик", "music", "label", "артист", "звук", "продюсер", "саунд"], phr: ["Твій ритм не зупинити ✦ грай на повну!", "Індустрія чекає саме тебе ✦", "Ще один трек — ще один крок до мрії ✦"] },
];

// "Бачу, ти <name>" after a CV upload
export function specialtyName(key) {
  const names = { design: gv("дизайнерка", "дизайнер", "дизайнер(ка)"), dev: gv("розробниця", "розробник", "розробник(ця)"), marketing: gv("маркетологиня", "маркетолог", "маркетолог(иня)"), pm: gv("проєктна менеджерка", "проєктний менеджер", "проєктн(а/ий) менеджер(ка)"), music: "з музичної сфери" };
  return names[key] || "профі";
}

// the specialty whose keywords appear most often in the text (null when none appear)
export function detectSpecialty(text) {
  if (!text) return null;
  const low = text.toLowerCase();
  let best = null, bestHits = 0;
  for (const s of SPECIALTIES) {
    const hits = s.kw.reduce((n, k) => n + (low.includes(k) ? 1 : 0), 0);
    if (hits > bestHits) { bestHits = hits; best = s; }
  }
  return bestHits >= 1 ? best : null;
}
