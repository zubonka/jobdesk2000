// App-wide publish/subscribe. Event names in use:
//   user       signed in, signed out, name or gender changed
//   jobs       vacancy list or a vacancy field changed (detail: { type, id?, key? }); types: add, field, update,
//              remove, restore (an undone remove), reset, import (from a backup), collapse, reload (from storage)
//   cv         CV text changed
//   fairy      fairy type, colours or name changed
//   wallpaper  desktop wallpaper changed
//   windows    a window opened, closed or got focus
//   gate       a guest tried to open a members-only app (detail: app name)
//   auth:open  someone asked for the sign-in dialog (detail: "login" | "register")
//   account    the account button or start menu account item was clicked
//   menu       a START menu command was chosen (detail: "backup" | "restore" | "table")
//   state      local data was replaced (from the cloud, another tab or a backup); every module reloads from storage
//   firebase   Firebase finished loading
//   storage-full  the browser refused to save (detail: the storage key); main.js tells the user

const handlers = new Map();

export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
  return () => handlers.get(name).delete(fn);
}

export function emit(name, detail) {
  for (const fn of handlers.get(name) || []) {
    try { fn(detail); } catch (err) { console.error(`[event ${name}]`, err); }
  }
}
