import type { ErrorCode } from './protocol'

const messages = {
  en: {
    input: 'Invalid parameters. Check the name, template, and mount mode.',
    sbxMissing: 'The sbx CLI was not found on the Orca host PATH.',
    version: 'Unsupported sbx version. Install Docker Sandboxes 0.48.0 or later.',
    format: 'Unrecognized sbx list format. Check your Docker Sandboxes version.',
    unavailable: 'Docker Sandboxes or the microVM is unavailable. Check the daemon and its Linux requirements.',
    login: 'Docker authentication is required. Run sbx login on the host.',
    policy: 'The network policy has not been initialized. Configure it manually in Docker Sandboxes.',
    timeout: 'The request timed out.',
    cancelled: 'The request was cancelled.',
    overflow: 'The command output exceeded the size limit.',
    path: 'Choose an absolute path to the root of the main Git checkout, without mount syntax.',
    gitMissing: 'Git was not found on the Orca host PATH.',
    confirm: 'Confirm the displayed canonical path before mounting the folder with read-write access.',
    collision: 'This name is already in use. Refresh the list and choose a different name.',
    stale: 'The target or its state has changed. Refresh the list before trying again.',
    busy: 'An action is already in progress for this sandbox.',
    create: 'Docker did not confirm that the sandbox was created.',
    stop: 'Docker did not confirm that the sandbox stopped. Close active sessions before trying again; the plugin does not force a stop.',
    sshMissing: 'OpenSSH was not found on the Orca host PATH.',
    ssh: 'OpenSSH failed. Check sbx login and sbx setup ssh, then use Test in Settings → SSH to troubleshoot Orca.'
  },
  fr: {
    input: 'Paramètres invalides. Vérifiez le nom, le gabarit et le mode de montage.',
    sbxMissing: 'CLI sbx introuvable sur le PATH de l’hôte Orca.',
    version: 'Version de sbx incompatible. Installez Docker Sandboxes 0.48.0 ou une version ultérieure.',
    format: 'Format de liste sbx inconnu. Vérifiez la version de Docker Sandboxes.',
    unavailable: 'Docker Sandboxes ou la microVM est indisponible. Vérifiez le daemon et ses prérequis Linux.',
    login: 'Authentification Docker requise. Exécutez sbx login sur l’hôte.',
    policy: 'Politique réseau non initialisée. Configurez-la manuellement dans Docker Sandboxes.',
    timeout: 'Le délai de réponse est dépassé.',
    cancelled: 'La requête a été interrompue.',
    overflow: 'La réponse de la commande dépasse la taille autorisée.',
    path: 'Choisissez un chemin absolu sans syntaxe de montage, vers la racine du checkout Git principal.',
    gitMissing: 'Git est introuvable sur le PATH de l’hôte Orca.',
    confirm: 'Confirmez le chemin canonique affiché avant de monter le dossier en lecture-écriture.',
    collision: 'Ce nom est déjà utilisé. Actualisez la liste et choisissez un autre nom.',
    stale: 'La cible ou son état a changé. Actualisez la liste avant de réessayer.',
    busy: 'Une action est déjà en cours pour cette sandbox.',
    create: 'Docker n’a pas confirmé la création de la sandbox.',
    stop: 'Docker n’a pas confirmé l’arrêt. Fermez les sessions actives avant de réessayer ; le plugin ne force pas l’arrêt.',
    sshMissing: 'OpenSSH est introuvable sur le PATH de l’hôte Orca.',
    ssh: 'Échec OpenSSH. Vérifiez sbx login et sbx setup ssh, puis utilisez Test dans Settings → SSH pour diagnostiquer Orca.'
  }
} satisfies Record<'en' | 'fr', Record<ErrorCode, string>>

export function workerMessage(locale: 'en' | 'fr', code: ErrorCode): string | undefined {
  const catalog = messages[locale]
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(catalog, code) ? catalog[code] : undefined
}
