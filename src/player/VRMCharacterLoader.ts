import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';
import { VRMCharacter } from './VRMCharacter';

export type VRMGender = 'male' | 'female';

export interface VRMModelConfig {
  gender: VRMGender;
  url: string;
}

export interface VRMMetrics {
  measuredHeight: number;
  groundOffset: number;
  hipsHeight: number;
  leftFootHeight: number;
  rightFootHeight: number;
}

export class VRMCharacterLoader {
  private static loader: GLTFLoader | null = null;

  private static getLoader(): GLTFLoader {
    if (!this.loader) {
      this.loader = new GLTFLoader();
      this.loader.register((parser) => new VRMLoaderPlugin(parser));
    }
    return this.loader;
  }

  public static readonly MODEL_CONFIGS: Record<VRMGender, VRMModelConfig> = {
    male: {
      gender: 'male',
      url: './assets/characters/male.vrm',
    },
    female: {
      gender: 'female',
      url: './assets/characters/female.vrm',
    },
  };

  /**
   * Loads a VRM 1.0 character model with production-quality ground alignment.
   *
   * Ground alignment procedure:
   * 1. Load VRM and initialize all systems (humanoid, spring bones, expressions)
   * 2. Set the character into its actual resting pose (arms lowered)
   * 3. Call vrm.update(0) so normalized bones sync to original bones
   * 4. Force a full skeleton/matrix update
   * 5. Measure the bounding box of the ACTUAL rendered pose
   * 6. Calculate groundOffset = -bbox.min.y so feet touch Y=0
   *
   * This ensures the ground offset is correct regardless of the VRM's
   * internal coordinate system or normalized bone transforms.
   */
  public static async loadVRM(
    gender: VRMGender,
    onProgress?: (percent: number) => void
  ): Promise<VRMCharacter> {
    const config = this.MODEL_CONFIGS[gender];
    const loader = this.getLoader();

    return new Promise((resolve, reject) => {
      loader.load(
        config.url,
        (gltf) => {
          const vrm: VRM = gltf.userData.vrm;
          if (!vrm) {
            reject(new Error(`[VRMCharacterLoader] Failed to extract VRM data from ${config.url}`));
            return;
          }

          // Validate humanoid
          if (!vrm.humanoid) {
            reject(new Error(`[VRMCharacterLoader] VRM ${config.url} has no humanoid data`));
            return;
          }

          // Log available bones for debugging
          const boneNames = Object.values(VRMHumanBoneName);
          const missingBones: string[] = [];
          boneNames.forEach((name) => {
            const node = vrm.humanoid!.getNormalizedBoneNode(name);
            if (!node) missingBones.push(name);
          });
          if (missingBones.length > 0) {
            console.warn(`[VRMCharacterLoader] ${gender}.vrm missing bones:`, missingBones);
          }

          // 1. Clean VRM geometry & joints
          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          VRMUtils.removeUnnecessaryJoints(gltf.scene);

          // 2. Enable shadows on all meshes
          gltf.scene.traverse((obj) => {
            if (obj instanceof THREE.Mesh || obj instanceof THREE.SkinnedMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
              // Force skinned meshes to update their bounding boxes on GPU
              if (obj instanceof THREE.SkinnedMesh) {
                obj.frustumCulled = false;
              }
              if (obj.material) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                mats.forEach((m) => {
                  m.needsUpdate = true;
                });
              }
            }
          });

          // 3. Set character into actual resting pose before measuring
          //    (Arms lowered from T-pose, legs straight)
          const REST_ARM_Z = 1.35;
          const leftUpperArm = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
          const rightUpperArm = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
          const leftLowerArm = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
          const rightLowerArm = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);

          if (leftUpperArm) leftUpperArm.rotation.set(0.05, 0, -REST_ARM_Z);
          if (rightUpperArm) rightUpperArm.rotation.set(0.05, 0, REST_ARM_Z);
          if (leftLowerArm) leftLowerArm.rotation.set(0, -0.15, 0);
          if (rightLowerArm) rightLowerArm.rotation.set(0, 0.15, 0);

          // 4. Step VRM runtime so normalized bones sync to original bones
          vrm.update(0);

          // 5. Force complete matrix world update
          gltf.scene.updateMatrixWorld(true);

          // 6. Measure bounding box in the actual rendered resting pose
          const bbox = new THREE.Box3().setFromObject(gltf.scene);
          const measuredHeight = bbox.max.y - bbox.min.y;
          const minY = bbox.min.y;
          const groundOffset = -minY;

          // 7. Align VRM so lowest visible geometry touches Y = 0
          vrm.scene.position.set(0, groundOffset, 0);

          // 8. Measure bone positions for diagnostics
          const hipsNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
          const leftFootNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftFoot);
          const rightFootNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightFoot);

          const metrics: VRMMetrics = {
            measuredHeight,
            groundOffset,
            hipsHeight: hipsNode ? hipsNode.getWorldPosition(new THREE.Vector3()).y + groundOffset : 0,
            leftFootHeight: leftFootNode ? leftFootNode.getWorldPosition(new THREE.Vector3()).y + groundOffset : 0,
            rightFootHeight: rightFootNode ? rightFootNode.getWorldPosition(new THREE.Vector3()).y + groundOffset : 0,
          };

          console.log(
            `[VRMCharacterLoader] ${gender}.vrm loaded: height=${measuredHeight.toFixed(3)}m, ` +
            `groundOffset=${groundOffset.toFixed(4)}m, bbox.min.y=${minY.toFixed(4)}, ` +
            `hips=${metrics.hipsHeight.toFixed(3)}m, ` +
            `leftFoot=${metrics.leftFootHeight.toFixed(3)}m, ` +
            `rightFoot=${metrics.rightFootHeight.toFixed(3)}m`
          );

          const character = new VRMCharacter(vrm, gender, measuredHeight, groundOffset, metrics);
          resolve(character);
        },
        (progress) => {
          if (progress.total > 0 && onProgress) {
            const percent = (progress.loaded / progress.total) * 100;
            onProgress(percent);
          }
        },
        (error) => {
          console.warn(`[VRMCharacterLoader] Local VRM ${config.url} not found or failed to load (${error}). Falling back to built-in procedural stylized character.`);
          const proceduralChar = VRMCharacterLoader.createProceduralCharacter(gender);
          resolve(proceduralChar);
        }
      );
    });
  }

  /**
   * Creates a stylized, rigged procedural 3D character conforming to the VRM 1.0 humanoid specification.
   * This ensures the application runs smoothly out of the box with zero external network or asset dependencies.
   */
  public static createProceduralCharacter(gender: VRMGender): VRMCharacter {
    const root = new THREE.Group();
    root.name = `VRM_Procedural_${gender}`;

    // Color palette
    const skinMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ffe2cb'),
      roughness: 0.6,
      flatShading: true,
    });
    const blushMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ff8fa3'),
      roughness: 0.5,
      transparent: true,
      opacity: 0.65,
    });
    const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const irisMat = new THREE.MeshBasicMaterial({
      color: gender === 'female' ? new THREE.Color('#a06cd5') : new THREE.Color('#00b4d8'),
    });
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x111111 });

    const hairMat = new THREE.MeshStandardMaterial({
      color: gender === 'female' ? new THREE.Color('#e07a5f') : new THREE.Color('#3d405b'),
      roughness: 0.5,
      flatShading: true,
    });

    const outfitTopMat = new THREE.MeshStandardMaterial({
      color: gender === 'female' ? new THREE.Color('#ffb7b2') : new THREE.Color('#457b9d'),
      roughness: 0.7,
      flatShading: true,
    });

    const outfitTrimMat = new THREE.MeshStandardMaterial({
      color: gender === 'female' ? new THREE.Color('#ffffff') : new THREE.Color('#e63946'),
      roughness: 0.6,
      flatShading: true,
    });

    const outfitBottomMat = new THREE.MeshStandardMaterial({
      color: gender === 'female' ? new THREE.Color('#3d5a80') : new THREE.Color('#1d3557'),
      roughness: 0.8,
      flatShading: true,
    });

    const shoeMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#f4f1de'),
      roughness: 0.4,
      flatShading: true,
    });

    // Bone Hierarchy
    const hips = new THREE.Group();
    hips.name = 'Hips';
    hips.position.set(0, 0.88, 0);
    root.add(hips);

    // Hips Mesh (Pelvis / Waist)
    const pelvisGeo = new THREE.CylinderGeometry(0.18, 0.16, 0.18, 12);
    const pelvisMesh = new THREE.Mesh(pelvisGeo, outfitBottomMat);
    pelvisMesh.castShadow = true;
    pelvisMesh.receiveShadow = true;
    hips.add(pelvisMesh);

    // Spine
    const spine = new THREE.Group();
    spine.name = 'Spine';
    spine.position.set(0, 0.12, 0);
    hips.add(spine);

    const lowerTorsoGeo = new THREE.CylinderGeometry(0.17, 0.18, 0.15, 12);
    const lowerTorsoMesh = new THREE.Mesh(lowerTorsoGeo, outfitTopMat);
    lowerTorsoMesh.castShadow = true;
    lowerTorsoMesh.receiveShadow = true;
    spine.add(lowerTorsoMesh);

    // Chest
    const chest = new THREE.Group();
    chest.name = 'Chest';
    chest.position.set(0, 0.14, 0);
    spine.add(chest);

    const upperTorsoGeo = new THREE.CylinderGeometry(0.20, 0.17, 0.22, 12);
    const upperTorsoMesh = new THREE.Mesh(upperTorsoGeo, outfitTopMat);
    upperTorsoMesh.castShadow = true;
    upperTorsoMesh.receiveShadow = true;
    chest.add(upperTorsoMesh);

    // Cute star emblem on chest
    const starGeo = new THREE.OctahedronGeometry(0.04, 0);
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
    const starMesh = new THREE.Mesh(starGeo, starMat);
    starMesh.position.set(0, 0.04, 0.20);
    chest.add(starMesh);

    // Neck
    const neck = new THREE.Group();
    neck.name = 'Neck';
    neck.position.set(0, 0.16, 0);
    chest.add(neck);

    const neckGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.10, 8);
    const neckMesh = new THREE.Mesh(neckGeo, skinMat);
    neckMesh.castShadow = true;
    neck.add(neckMesh);

    // Head
    const head = new THREE.Group();
    head.name = 'Head';
    head.position.set(0, 0.09, 0);
    neck.add(head);

    // Head base (Anime-proportioned soft head)
    const headGeo = new THREE.SphereGeometry(0.20, 16, 14);
    headGeo.scale(1.0, 1.1, 1.05);
    const headMesh = new THREE.Mesh(headGeo, skinMat);
    headMesh.position.set(0, 0.12, 0);
    headMesh.castShadow = true;
    headMesh.receiveShadow = true;
    head.add(headMesh);

    // Cheeks / Blush
    for (const side of [-1, 1]) {
      const blushGeo = new THREE.CircleGeometry(0.04, 8);
      const blush = new THREE.Mesh(blushGeo, blushMat);
      blush.position.set(side * 0.11, 0.10, 0.185);
      blush.rotation.y = side * 0.25;
      head.add(blush);
    }

    // Eyes container for blinking animation
    const eyesGroup = new THREE.Group();
    eyesGroup.position.set(0, 0.14, 0.17);
    head.add(eyesGroup);

    for (const side of [-1, 1]) {
      const eyeWhite = new THREE.Mesh(new THREE.PlaneGeometry(0.065, 0.075), eyeWhiteMat);
      eyeWhite.position.set(side * 0.075, 0, 0.01);
      eyeWhite.rotation.y = side * 0.22;

      const iris = new THREE.Mesh(new THREE.PlaneGeometry(0.045, 0.055), irisMat);
      iris.position.set(0, -0.005, 0.002);

      const pupil = new THREE.Mesh(new THREE.PlaneGeometry(0.025, 0.03), pupilMat);
      pupil.position.set(0, 0, 0.003);

      const highlight = new THREE.Mesh(new THREE.CircleGeometry(0.01, 6), eyeWhiteMat);
      highlight.position.set(0.01, 0.012, 0.004);

      iris.add(pupil, highlight);
      eyeWhite.add(iris);
      eyesGroup.add(eyeWhite);
    }

    // Hair
    const hairGroup = new THREE.Group();
    hairGroup.position.set(0, 0.14, 0);
    head.add(hairGroup);

    const hairCapGeo = new THREE.SphereGeometry(0.22, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.7);
    const hairCap = new THREE.Mesh(hairCapGeo, hairMat);
    hairCap.position.set(0, 0.02, -0.02);
    hairCap.castShadow = true;
    hairGroup.add(hairCap);

    // Bangs
    for (let b = -2; b <= 2; b++) {
      const bangGeo = new THREE.ConeGeometry(0.045, 0.16, 6);
      bangGeo.rotateX(Math.PI);
      const bang = new THREE.Mesh(bangGeo, hairMat);
      bang.position.set(b * 0.045, 0.08, 0.17);
      bang.rotation.z = -b * 0.12;
      bang.castShadow = true;
      hairGroup.add(bang);
    }

    if (gender === 'female') {
      // Twin Tails / Ponytails
      for (const side of [-1, 1]) {
        const pigtailGeo = new THREE.ConeGeometry(0.08, 0.45, 8);
        pigtailGeo.rotateZ(side * -0.2);
        const pigtail = new THREE.Mesh(pigtailGeo, hairMat);
        pigtail.position.set(side * 0.22, 0.02, -0.08);
        pigtail.castShadow = true;

        const scrunchie = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.015, 6, 12), outfitTrimMat);
        scrunchie.position.set(side * 0.20, 0.18, -0.06);
        hairGroup.add(pigtail, scrunchie);
      }
    } else {
      // Short anime back spikes
      for (let s = 0; s < 4; s++) {
        const spikeGeo = new THREE.ConeGeometry(0.05, 0.22, 6);
        spikeGeo.rotateX(-0.5);
        const spike = new THREE.Mesh(spikeGeo, hairMat);
        spike.position.set((s - 1.5) * 0.07, -0.04, -0.18);
        hairGroup.add(spike);
      }
    }

    // Arms
    const REST_ARM_Z = 1.35;

    // Left Arm
    const leftUpperArm = new THREE.Group();
    leftUpperArm.name = 'LeftUpperArm';
    leftUpperArm.position.set(0.24, 0.08, 0);
    leftUpperArm.rotation.set(0.05, 0, -REST_ARM_Z);
    chest.add(leftUpperArm);

    const lArmMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.24, 8), outfitTopMat);
    lArmMesh.position.set(0, -0.12, 0);
    lArmMesh.castShadow = true;
    leftUpperArm.add(lArmMesh);

    const leftLowerArm = new THREE.Group();
    leftLowerArm.name = 'LeftLowerArm';
    leftLowerArm.position.set(0, -0.24, 0);
    leftLowerArm.rotation.set(0, -0.15, 0);
    leftUpperArm.add(leftLowerArm);

    const lForearmMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.22, 8), skinMat);
    lForearmMesh.position.set(0, -0.11, 0);
    lForearmMesh.castShadow = true;
    leftLowerArm.add(lForearmMesh);

    const leftHand = new THREE.Group();
    leftHand.name = 'LeftHand';
    leftHand.position.set(0, -0.22, 0);
    leftLowerArm.add(leftHand);

    const lHandMesh = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), skinMat);
    lHandMesh.scale.set(1.0, 1.3, 0.7);
    lHandMesh.castShadow = true;
    leftHand.add(lHandMesh);

    // Right Arm
    const rightUpperArm = new THREE.Group();
    rightUpperArm.name = 'RightUpperArm';
    rightUpperArm.position.set(-0.24, 0.08, 0);
    rightUpperArm.rotation.set(0.05, 0, REST_ARM_Z);
    chest.add(rightUpperArm);

    const rArmMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.24, 8), outfitTopMat);
    rArmMesh.position.set(0, -0.12, 0);
    rArmMesh.castShadow = true;
    rightUpperArm.add(rArmMesh);

    const rightLowerArm = new THREE.Group();
    rightLowerArm.name = 'RightLowerArm';
    rightLowerArm.position.set(0, -0.24, 0);
    rightLowerArm.rotation.set(0, 0.15, 0);
    rightUpperArm.add(rightLowerArm);

    const rForearmMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.22, 8), skinMat);
    rForearmMesh.position.set(0, -0.11, 0);
    rForearmMesh.castShadow = true;
    rightLowerArm.add(rForearmMesh);

    const rightHand = new THREE.Group();
    rightHand.name = 'RightHand';
    rightHand.position.set(0, -0.22, 0);
    rightLowerArm.add(rightHand);

    const rHandMesh = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), skinMat);
    rHandMesh.scale.set(1.0, 1.3, 0.7);
    rHandMesh.castShadow = true;
    rightHand.add(rHandMesh);

    // Legs
    // Left Leg
    const leftUpperLeg = new THREE.Group();
    leftUpperLeg.name = 'LeftUpperLeg';
    leftUpperLeg.position.set(0.10, -0.06, 0);
    hips.add(leftUpperLeg);

    const lThighMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.38, 8), outfitBottomMat);
    lThighMesh.position.set(0, -0.19, 0);
    lThighMesh.castShadow = true;
    leftUpperLeg.add(lThighMesh);

    const leftLowerLeg = new THREE.Group();
    leftLowerLeg.name = 'LeftLowerLeg';
    leftLowerLeg.position.set(0, -0.38, 0);
    leftUpperLeg.add(leftLowerLeg);

    const lShinMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.36, 8), skinMat);
    lShinMesh.position.set(0, -0.18, 0);
    lShinMesh.castShadow = true;
    leftLowerLeg.add(lShinMesh);

    const leftFoot = new THREE.Group();
    leftFoot.name = 'LeftFoot';
    leftFoot.position.set(0, -0.36, 0.04);
    leftLowerLeg.add(leftFoot);

    const lShoeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.20), shoeMat);
    lShoeMesh.position.set(0, -0.04, 0.04);
    lShoeMesh.castShadow = true;
    leftFoot.add(lShoeMesh);

    // Right Leg
    const rightUpperLeg = new THREE.Group();
    rightUpperLeg.name = 'RightUpperLeg';
    rightUpperLeg.position.set(-0.10, -0.06, 0);
    hips.add(rightUpperLeg);

    const rThighMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.38, 8), outfitBottomMat);
    rThighMesh.position.set(0, -0.19, 0);
    rThighMesh.castShadow = true;
    rightUpperLeg.add(rThighMesh);

    const rightLowerLeg = new THREE.Group();
    rightLowerLeg.name = 'RightLowerLeg';
    rightLowerLeg.position.set(0, -0.38, 0);
    rightUpperLeg.add(rightLowerLeg);

    const rShinMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.36, 8), skinMat);
    rShinMesh.position.set(0, -0.18, 0);
    rShinMesh.castShadow = true;
    rightLowerLeg.add(rShinMesh);

    const rightFoot = new THREE.Group();
    rightFoot.name = 'RightFoot';
    rightFoot.position.set(0, -0.36, 0.04);
    rightLowerLeg.add(rightFoot);

    const rShoeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.20), shoeMat);
    rShoeMesh.position.set(0, -0.04, 0.04);
    rShoeMesh.castShadow = true;
    rightFoot.add(rShoeMesh);

    // VRM Adapter mapping
    const boneMap: Partial<Record<VRMHumanBoneName, THREE.Object3D>> = {
      [VRMHumanBoneName.Hips]: hips,
      [VRMHumanBoneName.Spine]: spine,
      [VRMHumanBoneName.Chest]: chest,
      [VRMHumanBoneName.Neck]: neck,
      [VRMHumanBoneName.Head]: head,
      [VRMHumanBoneName.LeftUpperArm]: leftUpperArm,
      [VRMHumanBoneName.LeftLowerArm]: leftLowerArm,
      [VRMHumanBoneName.LeftHand]: leftHand,
      [VRMHumanBoneName.RightUpperArm]: rightUpperArm,
      [VRMHumanBoneName.RightLowerArm]: rightLowerArm,
      [VRMHumanBoneName.RightHand]: rightHand,
      [VRMHumanBoneName.LeftUpperLeg]: leftUpperLeg,
      [VRMHumanBoneName.LeftLowerLeg]: leftLowerLeg,
      [VRMHumanBoneName.LeftFoot]: leftFoot,
      [VRMHumanBoneName.RightUpperLeg]: rightUpperLeg,
      [VRMHumanBoneName.RightLowerLeg]: rightLowerLeg,
      [VRMHumanBoneName.RightFoot]: rightFoot,
    };

    root.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(root);
    const measuredHeight = bbox.max.y - bbox.min.y;
    const groundOffset = -bbox.min.y;
    root.position.set(0, groundOffset, 0);

    const fakeHumanoid = {
      getNormalizedBoneNode: (name: VRMHumanBoneName) => boneMap[name] || null,
      getRawBoneNode: (name: VRMHumanBoneName) => boneMap[name] || null,
    };

    const fakeExpressionManager = {
      setValue: (_name: string, value: number) => {
        // Natural eye blink scale
        const scaleY = Math.max(0.08, 1.0 - value * 0.92);
        eyesGroup.scale.y = scaleY;
      },
    };

    const fakeVRM = {
      scene: root,
      humanoid: fakeHumanoid,
      expressionManager: fakeExpressionManager,
      update: (_dt: number) => {
        // No-op for procedural runtime
      },
    } as unknown as VRM;

    const metrics: VRMMetrics = {
      measuredHeight,
      groundOffset,
      hipsHeight: hips.position.y + groundOffset,
      leftFootHeight: 0,
      rightFootHeight: 0,
    };

    return new VRMCharacter(fakeVRM, gender, measuredHeight, groundOffset, metrics);
  }
}
