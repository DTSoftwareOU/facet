/**
 * The Windows app's own texts (notification-area menu, update window, file dialogs). Its main
 * process has no catalogs, so the interface hands it these, translated, with placeholders unfilled.
 */
import { lookup, msg } from '../i18n';

const SHELL = {
  open: msg('Open Facet AI'),
  quit: msg('Quit Facet AI'),
  remote: msg('Let your other devices use this PC'),
  startWithWindows: msg('Start with Windows'),
  remoteOn: msg('Your other devices can use this PC'),
  checking: msg('Checking for updates…'),
  updating: msg('Updating Facet AI'),
  downloading: msg('Downloading an update · {progress}'),
  starting: msg('Starting the download…'),
  installing: msg('Installing the update'),
  reopening: msg('Facet AI will open again in a moment.'),
  openNow: msg('Open Facet AI now'),
  chooseFolder: msg('Choose working folder'),
  fileOfType: msg('{ext} file'),
  allFiles: msg('All files'),
};

export type ShellStringKey = keyof typeof SHELL;
export type ShellStrings = Record<ShellStringKey, string>;

export function shellStrings(): ShellStrings {
  const out = {} as ShellStrings;
  for (const key of Object.keys(SHELL) as ShellStringKey[]) out[key] = lookup(SHELL[key]);
  return out;
}
