import { App, PluginSettingTab, Setting } from "obsidian";
import type ObstoryPlugin from "./plugin";
import { DEFAULT_SETTINGS } from "./constants";
import { OPENAI_CHAT_MODELS } from "./openaiModels";
import type { ModelProvider } from "./types";

export class ObstorySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObstoryPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obstory Settings" });

    // containerEl.createEl("h3", { text: "General" });

    new Setting(containerEl)
      .setName("Primary language")
      .setDesc("Suggestions prioritize this language but may still mirror other languages already in your note.")
      .addText((text) =>
        text
          .setPlaceholder("English")
          .setValue(this.plugin.settings.primaryLanguage)
          .onChange(async (value) => {
            this.plugin.settings.primaryLanguage = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Choose the AI service that generates completions and ghost suggestions.")
      .addDropdown((dropdown) => {
        const provider = this.plugin.settings.provider ?? "openai";
        dropdown.addOption("openai", "OpenAI");
        dropdown.setValue(provider);
        dropdown.onChange(async (value) => {
          this.plugin.settings.provider = value as ModelProvider;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const provider = this.plugin.settings.provider ?? "openai";
    if (provider === "openai") {
      new Setting(containerEl)
        .setName("API key")
        .setDesc(
          "Enter your OpenAI API key. The value is saved locally in plain text, so use a secrets manager if you can. " +
            "After you set a key, Obstory sends relevant note context to OpenAI in order to generate completions or ghost suggestions."
        )
        .addText((text) => {
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (value) => {
              this.plugin.settings.apiKey = value.trim();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
        });

      new Setting(containerEl)
        .setName("Model")
        .setDesc("Select the OpenAI chat model used for completions.")
        .addDropdown((dropdown) => {
          const current = this.plugin.settings.model?.trim();
          const knownOption = OPENAI_CHAT_MODELS.find((option) => option.value === current);
          const fallbackValue = OPENAI_CHAT_MODELS[0]?.value ?? "";
          const selectedValue = knownOption ? knownOption.value : fallbackValue;

          for (const option of OPENAI_CHAT_MODELS) {
            dropdown.addOption(option.value, option.label);
          }
          if (selectedValue) {
            dropdown.setValue(selectedValue);
            if (!knownOption && selectedValue !== current) {
              this.plugin.settings.model = selectedValue;
              void this.plugin.saveSettings();
            }
          }

          dropdown.onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          });
        });
    } else {
      containerEl.createEl("p", { text: "This provider does not expose any plugin options yet." });
    }

    // containerEl.createEl("h3", { text: "Completions" });

    new Setting(containerEl)
      .setName("Max Tokens")
      .setDesc("Set the maximum number of tokens the model can return for each completion.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxTokens))
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (value) => {
            const numberValue = Number(value);
            if (!Number.isNaN(numberValue) && numberValue > 0) {
              this.plugin.settings.maxTokens = numberValue;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Ghost Max Tokens")
      .setDesc("Set the maximum token count for a single ghost suggestion.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.ghostMaxTokens))
          .setValue(String(this.plugin.settings.ghostMaxTokens))
          .onChange(async (value) => {
            const numberValue = Number(value);
            if (!Number.isNaN(numberValue) && numberValue > 0) {
              this.plugin.settings.ghostMaxTokens = numberValue;
              await this.plugin.saveSettings();
            }
          })
      );

  }
}
