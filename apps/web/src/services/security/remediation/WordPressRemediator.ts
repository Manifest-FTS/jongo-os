import { coolifyMutate } from "@/lib/coolify";

export interface RemediationOptions {
  quarantineDir?: string;
}

export class WordPressRemediator {
  private coolifyServiceUuid: string;
  private quarantineDir: string;

  constructor(coolifyServiceUuid: string, options?: RemediationOptions) {
    this.coolifyServiceUuid = coolifyServiceUuid;
    this.quarantineDir = options?.quarantineDir || "/var/www/html/wp-content/_quarantine";
  }

  /**
   * Executes a command on the Coolify container
   */
  private async execCommand(command: string): Promise<any> {
    return coolifyMutate(`/api/v1/services/${this.coolifyServiceUuid}/execute`, "POST", {
      command
    });
  }

  /**
   * Re-installs WordPress core files to ensure no modifications
   */
  async verifyAndRestoreCore(): Promise<void> {
    console.log(`[WPRemediator] Verifying and restoring WP core for ${this.coolifyServiceUuid}`);
    await this.execCommand(`wp core verify-checksums || wp core download --skip-content --force`);
  }

  /**
   * Re-installs all plugins from wordpress.org repository to wipe out modifications
   */
  async verifyAndRestorePlugins(): Promise<void> {
    console.log(`[WPRemediator] Verifying and restoring plugins for ${this.coolifyServiceUuid}`);
    // This command finds plugins with mismatched checksums and reinstalls them
    const script = `
      FAILED_PLUGINS=$(wp plugin verify-checksums --format=json | grep -o '"plugin_name":"[^"]*' | cut -d'"' -f4 | sort -u || true)
      for PLUGIN in $FAILED_PLUGINS; do
        wp plugin install $PLUGIN --force
      done
    `;
    await this.execCommand(script);
  }

  /**
   * Moves a malicious file into a quarantine directory, preserving it but disabling execution
   */
  async quarantineFile(filePath: string): Promise<void> {
    console.log(`[WPRemediator] Quarantining file ${filePath}`);
    const script = `
      mkdir -p ${this.quarantineDir}
      chmod 700 ${this.quarantineDir}
      # Move file and append .quarantined so it cannot be executed by PHP-FPM
      mv "${filePath}" "${this.quarantineDir}/$(basename "${filePath}").quarantined"
    `;
    await this.execCommand(script);
  }

  /**
   * Secures the site by rotating salts and forcing all users to log out
   */
  async rotateSaltsAndCredentials(): Promise<void> {
    console.log(`[WPRemediator] Rotating salts for ${this.coolifyServiceUuid}`);
    // Regenerates salts which forces all users to log out
    await this.execCommand(`wp config shuffle-salts`);
  }

  /**
   * Runs the complete SOHPS remediation playbook
   */
  async executeFullPlaybook(infectedFiles: string[]): Promise<void> {
    await this.verifyAndRestoreCore();
    await this.verifyAndRestorePlugins();
    
    for (const file of infectedFiles) {
      await this.quarantineFile(file);
    }
    
    await this.rotateSaltsAndCredentials();
    console.log(`[WPRemediator] SOHPS Remediation Playbook complete.`);
  }
}
