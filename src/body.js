/* global Ammo */
import * as THREE from "three";

import CONSTANTS from "../constants.js";
const ACTIVATION_STATE = CONSTANTS.ACTIVATION_STATE,
  COLLISION_FLAG = CONSTANTS.COLLISION_FLAG,
  SHAPE = CONSTANTS.SHAPE,
  TYPE = CONSTANTS.TYPE,
  FIT = CONSTANTS.FIT;

const ACTIVATION_STATES = [
  ACTIVATION_STATE.ACTIVE_TAG,
  ACTIVATION_STATE.ISLAND_SLEEPING,
  ACTIVATION_STATE.WANTS_DEACTIVATION,
  ACTIVATION_STATE.DISABLE_DEACTIVATION,
  ACTIVATION_STATE.DISABLE_SIMULATION
];

const RIGID_BODY_FLAGS = {
  NONE: 0,
  DISABLE_WORLD_GRAVITY: 1
};

function almostEqualsVector3(epsilon, u, v) {
  return Math.abs(u.x - v.x) < epsilon && Math.abs(u.y - v.y) < epsilon && Math.abs(u.z - v.z) < epsilon;
}

function almostEqualsBtVector3(epsilon, u, v) {
  return Math.abs(u.x() - v.x()) < epsilon && Math.abs(u.y() - v.y()) < epsilon && Math.abs(u.z() - v.z()) < epsilon;
}

function almostEqualsQuaternion(epsilon, u, v) {
  return (
    (Math.abs(u.x - v.x) < epsilon &&
      Math.abs(u.y - v.y) < epsilon &&
      Math.abs(u.z - v.z) < epsilon &&
      Math.abs(u.w - v.w) < epsilon) ||
    (Math.abs(u.x + v.x) < epsilon &&
      Math.abs(u.y + v.y) < epsilon &&
      Math.abs(u.z + v.z) < epsilon &&
      Math.abs(u.w + v.w) < epsilon)
  );
}

/**
 * Initializes a body component, assigning it to the physics system and binding listeners for
 * parsing the elements geometry.
 *
 */
function Body(bodyConfig, matrix, world) {
  this.loadedEvent = bodyConfig.loadedEvent ? bodyConfig.loadedEvent : "";
  this.mass = bodyConfig.hasOwnProperty("mass") ? bodyConfig.mass : 1;
  this.hasSharedShapes = false;

  const worldGravity = world.physicsWorld.getGravity();
  this.gravity = new Ammo.btVector3(worldGravity.x(), worldGravity.y(), worldGravity.z());
  if (bodyConfig.gravity) {
    this.gravity.setValue(bodyConfig.gravity.x, bodyConfig.gravity.y, bodyConfig.gravity.z);
  }
  this.linearDamping = bodyConfig.hasOwnProperty("linearDamping") ? bodyConfig.linearDamping : 0.01;
  this.angularDamping = bodyConfig.hasOwnProperty("angularDamping") ? bodyConfig.angularDamping : 0.01;
  this.linearSleepingThreshold = bodyConfig.hasOwnProperty("linearSleepingThreshold")
    ? bodyConfig.linearSleepingThreshold
    : 1.6;
  this.angularSleepingThreshold = bodyConfig.hasOwnProperty("angularSleepingThreshold")
    ? bodyConfig.angularSleepingThreshold
    : 2.5;
  this.angularFactor = new THREE.Vector3(1, 1, 1);
  if (bodyConfig.angularFactor) {
    this.angularFactor.copy(bodyConfig.angularFactor);
  }
  this.activationState =
    bodyConfig.activationState && ACTIVATION_STATES.indexOf(bodyConfig.activationState) !== -1
      ? bodyConfig.activationState
      : ACTIVATION_STATE.ACTIVE_TAG;
  this.type = bodyConfig.type ? bodyConfig.type : TYPE.DYNAMIC;
  this.emitCollisionEvents = bodyConfig.hasOwnProperty("emitCollisionEvents") ? bodyConfig.emitCollisionEvents : false;
  this.disableCollision = bodyConfig.hasOwnProperty("disableCollision") ? bodyConfig.disableCollision : false;
  this.collisionFilterGroup = bodyConfig.hasOwnProperty("collisionFilterGroup") ? bodyConfig.collisionFilterGroup : 1; //32-bit mask
  this.collisionFilterMask = bodyConfig.hasOwnProperty("collisionFilterMask") ? bodyConfig.collisionFilterMask : 1; //32-bit mask
  this.scaleAutoUpdate = bodyConfig.hasOwnProperty("scaleAutoUpdate") ? bodyConfig.scaleAutoUpdate : true;

  this.matrix = matrix;
  this.world = world;
  this.shapes = [];
  this.initialSyncCount = 0;

  this._initBody();
}

/**
 * Parses an element's geometry and component metadata to create an Ammo body instance for the component.
 */
Body.prototype._initBody = (function() {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  return function() {
    this.localScaling = new Ammo.btVector3();

    this.matrix.decompose(pos, quat, scale);

    this.localScaling.setValue(scale.x, scale.y, scale.z);

    this.prevScale = new THREE.Vector3(1, 1, 1);
    this.prevNumChildShapes = 0;

    this.msTransform = new Ammo.btTransform();
    this.msTransform.setIdentity();
    this.rotation = new Ammo.btQuaternion(quat.x, quat.y, quat.z, quat.w);

    this.msTransform.getOrigin().setValue(pos.x, pos.y, pos.z);
    this.msTransform.setRotation(this.rotation);

    this.motionState = new Ammo.btDefaultMotionState(this.msTransform);

    this.localInertia = new Ammo.btVector3(0, 0, 0);

    this.compoundShape = new Ammo.btCompoundShape(true);
    this.compoundShape.setLocalScaling(this.localScaling);

    this.rbInfo = new Ammo.btRigidBodyConstructionInfo(
      this.mass,
      this.motionState,
      this.compoundShape,
      this.localInertia
    );
    this.physicsBody = new Ammo.btRigidBody(this.rbInfo);
    this.physicsBody.setActivationState(ACTIVATION_STATES.indexOf(this.activationState) + 1);
    this.physicsBody.setSleepingThresholds(this.linearSleepingThreshold, this.angularSleepingThreshold);

    this.physicsBody.setDamping(this.linearDamping, this.angularDamping);

    const angularFactor = new Ammo.btVector3(this.angularFactor.x, this.angularFactor.y, this.angularFactor.z);
    this.physicsBody.setAngularFactor(angularFactor);
    Ammo.destroy(angularFactor);

    if (!almostEqualsBtVector3(0.001, this.gravity, this.world.physicsWorld.getGravity())) {
      this.physicsBody.setGravity(this.gravity);
      this.physicsBody.setFlags(RIGID_BODY_FLAGS.DISABLE_WORLD_GRAVITY);
    }

    this.updateCollisionFlags();

    this.world.addBody(this.physicsBody, this.matrix, this.collisionFilterGroup, this.collisionFilterMask);

    if (this.emitCollisionEvents) {
      this.world.addEventListener(this.physicsBody);
    }
  };
})();

/**
 * Updates the body when shapes have changed. Should be called whenever shapes are added/removed or scale is changed.
 */
Body.prototype.updateShapes = (function() {
  const needsPolyhedralInitialization = [SHAPE.HULL, SHAPE.HACD, SHAPE.VHACD];
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  return function() {
    let updated = false;
    this.matrix.decompose(pos, quat, scale);
    if (this.scaleAutoUpdate && this.prevScale && !almostEqualsVector3(0.001, scale, this.prevScale)) {
      this.prevScale.copy(scale);
      updated = true;

      if (this.hasSharedShapes) {
        const convexShapes = [];

        if (this.shapes.length > 0) {
          for (let i = 0; i < this.shapes.length; i++) {
            const uniformScalingShape = this.shapes[i];
            convexShapes.push(uniformScalingShape.childShape);
          }

          this.updateUniformScaleShapes(convexShapes, scale.x);
        }
      } else {
        this.localScaling.setValue(this.prevScale.x, this.prevScale.y, this.prevScale.z);
        this.compoundShape.setLocalScaling(this.localScaling);
      }
    }

    if (this.shapesChanged) {
      this.shapesChanged = false;
      updated = true;
      if (this.type === TYPE.DYNAMIC) {
        this.updateMass();
      }

      this.world.updateBody(this.physicsBody);
    }

    //call initializePolyhedralFeatures for hull shapes if debug is turned on and/or scale changes
    if (this.world.isDebugEnabled() && (updated || !this.polyHedralFeaturesInitialized)) {
      for (let i = 0; i < this.shapes.length; i++) {
        const collisionShape = this.shapes[i];
        let polyShape = collisionShape;

        if (collisionShape.getChildShape) {
          polyShape = collisionShape.getChildShape();
        }
        if (needsPolyhedralInitialization.indexOf(polyShape.type) !== -1) {
          polyShape.initializePolyhedralFeatures(0);
        }
      }
      this.polyHedralFeaturesInitialized = true;
    }
  };
})();

/**
 * Update the configuration of the body.
 */
Body.prototype.update = function(bodyConfig) {
  if (
    (bodyConfig.type !== undefined && bodyConfig.type !== this.type) ||
    (bodyConfig.disableCollision !== undefined && bodyConfig.disableCollision !== this.disableCollision)
  ) {
    if (bodyConfig.type !== undefined) this.type = bodyConfig.type;
    if (bodyConfig.disableCollision !== undefined) this.disableCollision = bodyConfig.disableCollision;
    this.updateCollisionFlags();
  }

  if (bodyConfig.activationState !== undefined && bodyConfig.activationState !== this.activationState) {
    this.activationState = bodyConfig.activationState;
    this.physicsBody.forceActivationState(ACTIVATION_STATES.indexOf(this.activationState) + 1);
    if (this.activationState === ACTIVATION_STATE.ACTIVE_TAG) {
      this.physicsBody.activate(true);
    }
  }

  if (
    (bodyConfig.collisionFilterGroup !== undefined && bodyConfig.collisionFilterGroup !== this.collisionFilterGroup) ||
    (bodyConfig.collisionFilterMask !== undefined && bodyConfig.collisionFilterMask !== this.collisionFilterMask)
  ) {
    if (bodyConfig.collisionFilterGroup !== undefined) this.collisionFilterGroup = bodyConfig.collisionFilterGroup;
    if (bodyConfig.collisionFilterMask !== undefined) this.collisionFilterMask = bodyConfig.collisionFilterMask;
    const broadphaseProxy = this.physicsBody.getBroadphaseProxy();
    broadphaseProxy.set_m_collisionFilterGroup(this.collisionFilterGroup);
    broadphaseProxy.set_m_collisionFilterMask(this.collisionFilterMask);
    this.world.broadphase
      .getOverlappingPairCache()
      .removeOverlappingPairsContainingProxy(broadphaseProxy, this.world.dispatcher);
  }

  if (
    (bodyConfig.linearDamping !== undefined && bodyConfig.linearDamping != this.linearDamping) ||
    (bodyConfig.angularDamping !== undefined && bodyConfig.angularDamping != this.angularDamping)
  ) {
    if (bodyConfig.linearDamping !== undefined) this.linearDamping = bodyConfig.linearDamping;
    if (bodyConfig.angularDamping !== undefined) this.angularDamping = bodyConfig.angularDamping;
    this.physicsBody.setDamping(this.linearDamping, this.angularDamping);
  }

  if (bodyConfig.gravity !== undefined) {
    this.gravity.setValue(bodyConfig.gravity.x, bodyConfig.gravity.y, bodyConfig.gravity.z);
    if (!almostEqualsBtVector3(0.001, this.gravity, this.physicsBody.getGravity())) {
      if (!almostEqualsBtVector3(0.001, this.gravity, this.world.physicsWorld.getGravity())) {
        this.physicsBody.setFlags(RIGID_BODY_FLAGS.DISABLE_WORLD_GRAVITY);
      } else {
        this.physicsBody.setFlags(RIGID_BODY_FLAGS.NONE);
      }
      this.physicsBody.setGravity(this.gravity);
    }
  }

  if (
    (bodyConfig.linearSleepingThreshold !== undefined &&
      bodyConfig.linearSleepingThreshold != this.linearSleepingThreshold) ||
    (bodyConfig.angularSleepingThreshold !== undefined &&
      bodyConfig.angularSleepingThreshold != this.angularSleepingThreshold)
  ) {
    if (bodyConfig.linearSleepingThreshold !== undefined)
      this.linearSleepingThreshold = bodyConfig.linearSleepingThreshold;
    if (bodyConfig.angularSleepingThreshold !== undefined)
      this.angularSleepingThreshold = bodyConfig.angularSleepingThreshold;
    this.physicsBody.setSleepingThresholds(this.linearSleepingThreshold, this.angularSleepingThreshold);
  }

  if (
    bodyConfig.angularFactor !== undefined &&
    !almostEqualsVector3(0.001, bodyConfig.angularFactor, this.angularFactor)
  ) {
    this.angularFactor.copy(bodyConfig.angularFactor);
    const angularFactor = new Ammo.btVector3(this.angularFactor.x, this.angularFactor.y, this.angularFactor.z);
    this.physicsBody.setAngularFactor(angularFactor);
    Ammo.destroy(angularFactor);
  }

  //TODO: support dynamic update for other properties
};

/**
 * Removes the component and all physics and scene side effects.
 */
Body.prototype.destroy = function() {
  if (this.triMesh) Ammo.destroy(this.triMesh);
  if (this.localScaling) Ammo.destroy(this.localScaling);

  for (let i = 0; i < this.shapes.length; i++) {
    this.compoundShape.removeChildShape([i]);
  }
  if (this.compoundShape) Ammo.destroy(this.compoundShape);

  this.world.removeBody(this.physicsBody);
  Ammo.destroy(this.physicsBody);
  delete this.physicsBody;
  Ammo.destroy(this.rbInfo);
  Ammo.destroy(this.msTransform);
  Ammo.destroy(this.motionState);
  Ammo.destroy(this.localInertia);
  Ammo.destroy(this.rotation);
  Ammo.destroy(this.gravity);
};

/**
 * Updates the rigid body's position, velocity, and rotation, based on the scene.
 */
Body.prototype.syncToPhysics = (function() {
  const pos = new THREE.Vector3(),
    quat = new THREE.Quaternion(),
    scale = new THREE.Vector3(),
    q = new THREE.Vector3(),
    v = new THREE.Vector3();
  return function(setCenterOfMassTransform) {
    const body = this.physicsBody;
    if (!body) return;

    this.motionState.getWorldTransform(this.msTransform);

    this.matrix.decompose(pos, quat, scale);

    const position = this.msTransform.getOrigin();
    v.set(position.x(), position.y(), position.z());

    const quaternion = this.msTransform.getRotation();
    q.set(quaternion.x(), quaternion.y(), quaternion.z(), quaternion.w());

    if (!almostEqualsVector3(0.001, pos, v) || !almostEqualsQuaternion(0.001, quat, q)) {
      if (!this.physicsBody.isActive()) {
        this.physicsBody.activate(true);
      }
      this.msTransform.getOrigin().setValue(pos.x, pos.y, pos.z);
      this.rotation.setValue(quat.x, quat.y, quat.z, quat.w);
      this.msTransform.setRotation(this.rotation);
      this.motionState.setWorldTransform(this.msTransform);

      if (this.type === TYPE.STATIC || setCenterOfMassTransform) {
        this.physicsBody.setCenterOfMassTransform(this.msTransform);
      }
    }
  };
})();

/**
 * Updates the scene object's position and rotation, based on the physics simulation.
 */
Body.prototype.syncFromPhysics = (function() {
  const pos = new THREE.Vector3(),
    quat = new THREE.Quaternion(),
    scale = new THREE.Vector3();
  return function() {
    this.motionState.getWorldTransform(this.msTransform);
    const position = this.msTransform.getOrigin();
    const quaternion = this.msTransform.getRotation();

    const body = this.physicsBody;

    if (!body) return;
    this.matrix.decompose(pos, quat, scale);
    pos.set(position.x(), position.y(), position.z());
    quat.set(quaternion.x(), quaternion.y(), quaternion.z(), quaternion.w());
    this.matrix.compose(pos, quat, scale);
  };
})();

Body.prototype.updateUniformScaleShapes = function(convexShapes, scale) {
  for (let i = 0; i < this.shapes.length; i++) {
    const scalingShape = this.shapes[i];
    this.compoundShape.removeChildShape(scalingShape);
    Ammo.destroy(scalingShape);
  }

  this.shapes.length = 0;

  for (const collisionShape of convexShapes) {
    const scalableShape = new Ammo.btUniformScalingShape(collisionShape, scale);

    // Keep a JS object-ified reference as well to child, which has other properties
    scalableShape.childShape = collisionShape;

    this.shapes.push(scalableShape);
    const basis = collisionShape.localTransform.getRotation();
    const origin = collisionShape.localTransform.getOrigin();
    const newOrigin = new Ammo.btVector3();
    newOrigin.setX(origin.x() * scale);
    newOrigin.setY(origin.y() * scale);
    newOrigin.setZ(origin.z() * scale);
    const t = new Ammo.btTransform(basis, newOrigin);
    this.compoundShape.addChildShape(t, scalableShape);
    Ammo.destroy(t);
    Ammo.destroy(newOrigin);
  }
};

// Pass in a list of convex collision shapes and efficiently set them on this body.
// When using this, shapes can be shared across bodies.
Body.prototype.setShapes = (function() {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  return function(collisionShapes) {
    const convexShapes = [];

    for (const collisionShape of collisionShapes) {
      if (
        collisionShape.type !== SHAPE.BOX &&
        collisionShape.type !== SHAPE.CONE &&
        collisionShape.type !== SHAPE.CYLINDER &&
        collisionShape.type !== SHAPE.CAPSULE &&
        collisionShape.type !== SHAPE.HULL &&
        collisionShape.type !== SHAPE.HACD &&
        collisionShape.type !== SHAPE.VHACD
      ) {
        console.warn("setShapes expects convex shapes since it allows unique scaling", collisionShape.type);
        continue;
      }

      convexShapes.push(collisionShape);
    }

    if (!this.hasSharedShapes) {
      this.hasSharedShapes = true;
      this.localScaling.setValue(1, 1, 1);
      this.compoundShape.setLocalScaling(this.localScaling);
    }

    this.updateUniformScaleShapes(convexShapes, this.prevScale.x);
    this.shapesChanged = true;
  };
})();

Body.prototype.addShape = function(collisionShape) {
  if (collisionShape.type === SHAPE.MESH && this.type !== TYPE.STATIC) {
    console.warn("non-static mesh colliders not supported");
    return;
  }

  this.shapes.push(collisionShape);
  this.compoundShape.addChildShape(collisionShape.localTransform, collisionShape);
  this.compoundShape.setLocalScaling(this.localScaling);
  this.shapesChanged = true;
  this.updateShapes();
};

Body.prototype.removeShape = function(collisionShape) {
  if (!this.compoundShape) return;

  for (let i = 0; i < this.shapes.length; i++) {
    let shape = this.shapes[i];

    if (shape === collisionShape || shape.childShape === collisionShape) {
      this.compoundShape.removeChildShape(shape);

      // Destroy wrapping uniform scale shape
      if (shape.childShape) {
        Ammo.destroy(shape);
      }

      this.shapesChanged = true;
      this.shapes.splice(i, 1);
      this.updateShapes();
      break;
    }
  }
};

Body.prototype.updateMass = function() {
  const mass = this.type === TYPE.STATIC ? 0 : this.mass;
  this.compoundShape.calculateLocalInertia(mass, this.localInertia);
  this.physicsBody.setMassProps(mass, this.localInertia);
  this.physicsBody.updateInertiaTensor();
};

Body.prototype.updateCollisionFlags = function() {
  let flags = this.disableCollision ? 4 : 0;
  switch (this.type) {
    case TYPE.STATIC:
      flags |= COLLISION_FLAG.STATIC_OBJECT;
      break;
    case TYPE.KINEMATIC:
      flags |= COLLISION_FLAG.KINEMATIC_OBJECT;
      break;
    default:
      this.physicsBody.applyGravity();
      break;
  }
  this.physicsBody.setCollisionFlags(flags);

  this.updateMass();

  // TODO: enable CCD if dynamic?
  // this.physicsBody.setCcdMotionThreshold(0.001);
  // this.physicsBody.setCcdSweptSphereRadius(0.001);

  this.world.updateBody(this.physicsBody);
};

Body.prototype.getVelocity = function() {
  return this.physicsBody.getLinearVelocity();
};

export default Body;
