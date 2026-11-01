
<template>
  <div v-if="open" class="dialog-backdrop" @mousedown.self="$emit('close')">
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
      <button type="button" class="dialog-close" aria-label="关闭确认对话框" @click="$emit('close')"><X :size="18" /></button>
      <AlertTriangle :size="24" class="dialog-warning" />
      <h2 id="confirm-title">{{ title }}</h2>
      <p id="confirm-description">{{ description }}</p>
      <div class="dialog-actions">
        <button type="button" class="secondary-button" @click="$emit('close')">返回检查</button>
        <button ref="confirmRef" type="button" class="primary-button" @click="confirm">{{ confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>



<script lang="ts">
import { defineComponent } from 'vue'
import { AlertTriangle, X } from '@lucide/vue'

export default defineComponent({
  name: 'ConfirmDialog',
  components: { AlertTriangle, X },
  props: {
    open: { type: Boolean, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    confirmLabel: { type: String, required: true },
  },
  emits: ['confirm', 'close'],
  watch: {
    open: {
      immediate: true,
      async handler(open: boolean) {
        if (!open) return
        await this.$nextTick()
        const button = this.$refs.confirmRef as HTMLButtonElement | undefined
        button?.focus()
      },
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onKey)
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey)
  },
  methods: {
    onKey(event: KeyboardEvent) {
      if (this.open && event.key === 'Escape') this.$emit('close')
    },
    confirm() {
      this.$emit('confirm')
      this.$emit('close')
    },
  },
})
</script>
