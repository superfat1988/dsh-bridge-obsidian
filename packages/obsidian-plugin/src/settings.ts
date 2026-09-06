/**
 * Plugin settings: bridge address, bearer token, write-approval mode, and the
 * auto-reconnect toggle. The chat view and executor read these live.
 *
 * @module
 */

import { PluginSettingTab, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type DshBridgePlugin from './main.ts'

export interface DshBridgeSettings {
  /** Base address of the dsh web server, e.g. http://192.168.2.185:3080. */
  bridgeBase: string
  /** Bearer token from ~/.dsh/obsidian-bridge-token on the NAS. */
  token: string
  /** 'ask' shows a confirmation modal before every agent write; 'auto' writes directly. */
  writeApproval: 'ask' | 'auto'
  /** Connect automatically when Obsidian loads. */
  autoConnect: boolean
}

export const DEFAULT_SETTINGS: DshBridgeSettings = {
  bridgeBase: 'http://192.168.2.185:3080',
  token: '',
  writeApproval: 'ask',
  autoConnect: true,
}

export class DshBridgeSettingTab extends PluginSettingTab {
  private readonly plugin: DshBridgePlugin

  constructor(app: App, plugin: DshBridgePlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl).setName('DSH 桥接（Bridge）').setHeading()

    new Setting(containerEl)
      .setName('DSH 服务地址')
      .setDesc('dsh web 服务地址，例如 http://192.168.2.185:3080（公网用 https://dsh.kait.top:3333，但公网 WS 会被雷池拦截，仅 LAN 可靠）')
      .addText(text => text
        .setPlaceholder('http://192.168.2.185:3080')
        .setValue(this.plugin.settings.bridgeBase)
        .onChange(async value => {
          this.plugin.settings.bridgeBase = value.trim()
          await this.plugin.saveSettings()
        }))

    new Setting(containerEl)
      .setName('桥接 Token')
      .setDesc('NAS 上 ~/.dsh/obsidian-bridge-token 文件的内容（非回环连接必填）')
      .addText(text => {
        text.inputEl.type = 'password'
        return text
          .setPlaceholder('桥接 token')
          .setValue(this.plugin.settings.token)
          .onChange(async value => {
            this.plugin.settings.token = value.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('写入前询问')
      .setDesc('开启后，agent 每次写入/新建笔记前都会弹出确认（推荐）；关闭则直接写入')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.writeApproval === 'ask')
        .onChange(async value => {
          this.plugin.settings.writeApproval = value ? 'ask' : 'auto'
          await this.plugin.saveSettings()
        }))

    new Setting(containerEl)
      .setName('自动连接')
      .setDesc('Obsidian 启动时自动连接桥接服务')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoConnect)
        .onChange(async value => {
          this.plugin.settings.autoConnect = value
          await this.plugin.saveSettings()
        }))

    new Setting(containerEl)
      .setName('重新连接')
      .setDesc('保存设置后如修改了地址或 token，点击此按钮生效')
      .addButton(button => button
        .setButtonText('连接')
        .setCta()
        .onClick(() => { void this.plugin.reconnect() }))
  }
}
