// Application statuses. The app works with keys; storage and the UI use the label in the user's
// grammatical gender. Any gender's label maps back to the same key, so saved data survives a gender change.

export const STATUS_KEYS = ["not_applied", "applied", "interview1", "test", "interview2", "interview3", "offer", "reject"];
export const INTERVIEW_KEYS = ["interview1", "interview2", "interview3"];
// statuses the fairy celebrates
export const HAPPY_KEYS = ["offer", "interview1", "interview2", "interview3", "test"];

const LABELS = {
  f: ["Не подавалася", "Подалася", "Перша співбесіда", "Тестове завдання", "Друга співбесіда", "Третя співбесіда", "Оффер", "Відмова"],
  m: ["Не подавався", "Подався", "Перша співбесіда", "Тестове завдання", "Друга співбесіда", "Третя співбесіда", "Оффер", "Відмова"],
  n: ["Не подавалися", "Подалися", "Перша співбесіда", "Тестове завдання", "Друга співбесіда", "Третя співбесіда", "Оффер", "Відмова"],
};

export const statusLabels = (gender) => LABELS[gender] || LABELS.n;

export function statusLabel(key, gender) {
  const i = STATUS_KEYS.indexOf(key);
  return statusLabels(gender)[i >= 0 ? i : 0];
}

export function statusKeyOf(label) {
  for (const forms of Object.values(LABELS)) {
    const i = forms.indexOf(label);
    if (i >= 0) return STATUS_KEYS[i];
  }
  return STATUS_KEYS.includes(label) ? label : "not_applied";
}
