<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertTriangle, X } from '@lucide/vue'

const props = defineProps<{
  open: boolean
  title: string
  description: string
  confirmLabel: string
}>()

const emit = defineEmits<{
  confirm: []
  close: []
}>()

const confirmRef = ref<HTMLButtonElement | null>(null)

watch(() => props.open, async (open) => {
  if (!open) return
  await nextTick()
  confirmRef.value?.focus()
}, { immediate: true })

const onKey = (event: KeyboardEvent) => {
  if (props.open && event.key === 'Escape') emit('close')
}

const confirm = () => {
  emit('confirm')
  emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="open" class="dialog-backdrop" @mousedown.self="emit('close')">
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
      <button type="button" class="dialog-close" aria-label="关闭确认对话框" @click="emit('close')"><X :size="18" /></button>
      <AlertTriangle :size="24" class="dialog-warning" />
      <h2 id="confirm-title">{{ title }}</h2>
      <p id="confirm-description">{{ description }}</p>
      <div class="dialog-actions">
        <button type="button" class="secondary-button" @click="emit('close')">返回检查</button>
        <button ref="confirmRef" type="button" class="primary-button" @click="confirm">{{ confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>
