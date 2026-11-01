
<template>
  <div ref="rootRef" class="robot-scene">
    <div ref="hostRef" class="scene-canvas" aria-label="reBot B601-RS 三维关节反馈视图" />
    <div class="scene-topline">
      <div>
        <span class="live-dot" :class="{ 'is-running': running }" />
        <span>{{ running ? 'EXECUTING' : 'LIVE MODEL' }}</span>
      </div>
      <span>B601-RS · 6 AXIS + GRIPPER</span>
    </div>
    <div class="scene-actions">
      <button type="button" class="icon-button" title="复位视角" aria-label="复位视角" @click="resetCamera">
        <RotateCcw :size="16" />
      </button>
      <button type="button" class="icon-button" title="全屏查看" aria-label="全屏查看" @click="requestFullscreen">
        <Expand :size="16" />
      </button>
    </div>
    <div class="scene-axis" aria-hidden="true">
      <span class="axis-z">Z</span>
      <span class="axis-y">Y</span>
      <span class="axis-x">X</span>
    </div>
    <div v-if="status === 'loading'" class="scene-message">正在装载 URDF 与轻量网格…</div>
    <div v-if="status === 'error'" class="scene-message scene-message-error">3D 模型未能载入；关节控制与数据仍可使用。</div>
    <div class="scene-footer">
      <span>拖动旋转 · 滚轮缩放</span>
      <span>URDF / OBJ</span>
    </div>
  </div>
</template>


<script lang="ts">
import { defineComponent, markRaw } from 'vue'
import type { PropType } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import URDFLoader from 'urdf-loader'
import { Expand, RotateCcw } from '@lucide/vue'
import { JOINT_NAMES } from '@/lib/robot'

type Joint = { setJointValue: (value: number) => void }
type RobotObject = THREE.Object3D & { joints: Record<string, Joint> }

const MESH_COLORS: Record<string, number> = {
  base_link: 0x384454,
  link1: 0xc5ccd4,
  link2: 0x8794a3,
  link3: 0xbac3cd,
  link4: 0x8794a3,
  link5: 0xc5ccd4,
  link6: 0x8794a3,
  gripper_left: 0x526171,
  gripper_right: 0x526171,
  gripper_end: 0x9aa7b5,
}

function applyPose(robot: RobotObject | null, joints: number[], gripperRaw: number) {
  if (!robot?.joints) return
  JOINT_NAMES.forEach((name, index) => robot.joints[name]?.setJointValue(joints[index] ?? 0))
  const opening = Math.max(0, Math.min(1, gripperRaw / 5))
  robot.joints.joint_left?.setJointValue(opening * 0.05)
  robot.joints.joint_right?.setJointValue(opening * 0.0715)
}

export default defineComponent({
  name: 'RobotScene',
  components: { Expand, RotateCcw },
  props: {
    joints: { type: Array as PropType<number[]>, required: true },
    gripperRaw: { type: Number, required: true },
    running: { type: Boolean, required: true },
  },
  data() {
    return {
      status: 'loading' as 'loading' | 'ready' | 'error',
      latestPose: { joints: this.joints, gripperRaw: this.gripperRaw },
      robotObject: null as RobotObject | null,
      camera: null as THREE.PerspectiveCamera | null,
      controls: null as OrbitControls | null,
      disposeScene: undefined as (() => void) | undefined,
    }
  },
  watch: {
    joints: {
      deep: true,
      handler(joints: number[]) {
        this.latestPose.joints = joints
        applyPose(this.robotObject, joints, this.latestPose.gripperRaw)
      },
    },
    gripperRaw(gripperRaw: number) {
      this.latestPose.gripperRaw = gripperRaw
      applyPose(this.robotObject, this.latestPose.joints, gripperRaw)
    },
  },
  mounted() {
    const host = this.$refs.hostRef as HTMLDivElement | undefined
    if (!host) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    } catch {
      this.status = 'error'
      return
    }

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x070b13)
    scene.fog = new THREE.Fog(0x070b13, 1.5, 3.5)
    const camera = markRaw(new THREE.PerspectiveCamera(39, 1, 0.01, 100))
    this.camera = camera
    camera.position.set(0.95, 0.72, 1.08)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    host.appendChild(renderer.domElement)

    const controls = markRaw(new OrbitControls(camera, renderer.domElement))
    this.controls = controls
    controls.target.set(0, 0.3, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 0.65
    controls.maxDistance = 2.4
    controls.maxPolarAngle = Math.PI * 0.49

    scene.add(new THREE.HemisphereLight(0xdde9f5, 0x111a2b, 2.1))
    const key = new THREE.DirectionalLight(0xf3f7fb, 3.2)
    key.position.set(1.5, 2.4, 1.6)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x22d3ee, 1.1)
    rim.position.set(-1.2, 0.7, -1.5)
    scene.add(rim)

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1.25, 64),
      new THREE.MeshStandardMaterial({ color: 0x0c1220, roughness: 0.95, metalness: 0.05 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.004
    scene.add(ground)
    const grid = new THREE.GridHelper(2.4, 24, 0x1f4b5a, 0x182439)
    grid.position.y = 0
    scene.add(grid)

    const base = import.meta.env.BASE_URL
    const loader = new URDFLoader()
    loader.loadMeshCb = (path, manager, _material, done) => {
      const stem = (path.split(/[/\\]/).pop() || '').replace(/\.[^.]+$/, '').toLowerCase()
      const color = MESH_COLORS[stem]
      if (color === undefined) {
        done(new THREE.Group())
        return
      }
      new OBJLoader(manager).load(
        `${base}robot/B601-Lite-RS_OBJ/${stem}.obj`,
        (object) => {
          const material = new THREE.MeshStandardMaterial({ color, metalness: 0.32, roughness: 0.52 })
          object.traverse((child) => {
            if (child instanceof THREE.Mesh) child.material = material
          })
          done(object)
        },
        undefined,
        () => done(new THREE.Group()),
      )
    }

    let disposed = false
    loader.load(
      `${base}robot/resources/arm03/reBot_Lite_RS_with_gripper/urdf/reBot_Lite_RS_with_gripper.urdf`,
      (robot) => {
        if (disposed) return
        const object = markRaw(robot as unknown as RobotObject)
        object.rotation.x = -Math.PI / 2
        object.position.y = 0.006
        scene.add(object)
        this.robotObject = object
        applyPose(object, this.latestPose.joints, this.latestPose.gripperRaw)
        this.status = 'ready'
      },
      undefined,
      () => {
        if (!disposed) this.status = 'error'
      },
    )

    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    let frame = 0
    const animate = () => {
      controls.update()
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    animate()

    this.disposeScene = () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          materials.forEach((material) => material.dispose())
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
      this.robotObject = null
    }
  },
  beforeUnmount() {
    this.disposeScene?.()
  },
  methods: {
    resetCamera() {
      this.camera?.position.set(0.95, 0.72, 1.08)
      this.controls?.target.set(0, 0.3, 0)
      this.controls?.update()
    },
    requestFullscreen() {
      const root = this.$refs.rootRef as HTMLDivElement | undefined
      void root?.requestFullscreen?.()
    },
  },
})
</script>
