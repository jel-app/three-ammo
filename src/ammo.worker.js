import CONSTANTS from "../constants.js";
const MESSAGE_TYPES = CONSTANTS.MESSAGE_TYPES;
const TYPE = CONSTANTS.TYPE;
const SHAPE = CONSTANTS.SHAPE;
const FIT = CONSTANTS.FIT;
const CONSTRAINT = CONSTANTS.CONSTRAINT;
const BUFFER_CONFIG = CONSTANTS.BUFFER_CONFIG;
const BUFFER_STATE = CONSTANTS.BUFFER_STATE;
import * as THREE from "three";
import World from "./world";
import Body from "./body";
import Constraint from "./constraint";
import { DefaultBufferSize } from "ammo-debug-drawer";

import { createCollisionShapes } from "three-to-ammo";

import Ammo from "ammo.js/builds/ammo.wasm.js";
import AmmoWasm from "ammo.js/builds/ammo.wasm.wasm";

function initializeWasm(wasmUrl) {
  return Ammo.bind(undefined, {
    locateFile(path) {
      if (path.endsWith(".wasm")) {
        if (wasmUrl) {
          return wasmUrl;
        } else {
          return new URL(AmmoWasm, location.origin).href;
        }
      }
      return path;
    }
  });
}

const uuids = [];
const bodies = {};
const shapes = {};
const constraints = {};
const matrices = {};
const indexes = {};
const ptrToIndex = {};

// Map of body uuid -> shapes uuid that created + added via ADD_SHAPE, so there is a one
// to one relationship between shapes and the body.
//
// If the caller users CREATE_SHAPES/SET_SHAPES to assign the same shape to multiple bodies, then
// they must also call DESTROY_SHAPES on the relevant shapes when finished.
const singleBodyShapes = new Map();

let tempVec3_1 = null,
  tempVec3_2 = null;

const messageQueue = [];

const tmpMatrix = new THREE.Matrix4();
const tmpVec3 = new THREE.Vector3(1, 1, 1);

let simulationRate;

let stepDuration = 0;

let freeIndex = 0;

let freeIndexArray;

let world,
  headerIntArray,
  headerFloatArray,
  objectMatricesFloatArray,
  objectMatricesIntArray,
  lastTick,
  getPointer,
  ammoDestroy;
let usingSharedArrayBuffer = false;

function isBufferConsumed() {
  if (usingSharedArrayBuffer) {
    return headerIntArray && Atomics.load(headerIntArray, 0) !== BUFFER_STATE.READY;
  } else {
    return objectMatricesFloatArray && objectMatricesFloatArray.buffer.byteLength !== 0;
  }
}

function releaseBuffer() {
  if (usingSharedArrayBuffer) {
    headerFloatArray[1] = stepDuration;
    Atomics.store(headerIntArray, 0, BUFFER_STATE.READY);
  } else {
    postMessage({ type: MESSAGE_TYPES.TRANSFER_DATA, objectMatricesFloatArray, stepDuration }, [
      objectMatricesFloatArray.buffer
    ]);
  }
}

const tick = () => {
  setTimeout(tick, simulationRate);

  if (isBufferConsumed()) {
    const now = performance.now();
    const dt = now - lastTick;
    world.step(dt / 1000);
    stepDuration = performance.now() - now;
    lastTick = now;

    while (messageQueue.length > 0) {
      const message = messageQueue.shift();
      switch (message.type) {
        case MESSAGE_TYPES.ADD_BODY:
          addBody(message);
          break;
        case MESSAGE_TYPES.UPDATE_BODY:
          updateBody(message);
          break;
        case MESSAGE_TYPES.REMOVE_BODY:
          removeBody(message);
          break;
        case MESSAGE_TYPES.ADD_SHAPES:
          addShapes(message);
          break;
        case MESSAGE_TYPES.DESTROY_SHAPES:
          destroyShapes(message);
          break;
        case MESSAGE_TYPES.SET_SHAPES:
          const { shapesUuid, bodyUuids } = message;

          if (shapes[shapesUuid]) {
            for (const bodyUuid of bodyUuids) {
              if (bodies[bodyUuid]) {
                setShapes(bodyUuid, message);
              }
            }
          }

          break;
        case MESSAGE_TYPES.UPDATE_SHAPES_SCALE:
          updateShapesScale(message);
          break;
        case MESSAGE_TYPES.ADD_CONSTRAINT:
          addConstraint(message);
          break;
        case MESSAGE_TYPES.RESET_DYNAMIC_BODY:
          resetDynamicBody(message);
          break;
        case MESSAGE_TYPES.ACTIVATE_BODY:
          activateBody(message);
          break;
        case MESSAGE_TYPES.APPLY_IMPULSE:
          applyImpulse(message);
          break;
      }
    }

    /** Buffer Schema
     * Every physics body has 26 * 4 bytes (64bit float/int) assigned in the buffer
     * 0-15:  Matrix4 elements (floats)
     * 16:    Linear Velocity (float)
     * 17:    Angular Velocity (float)
     * 18-25: first 8 Collisions (ints)
     */

    for (let i = 0; i < uuids.length; i++) {
      const uuid = uuids[i];
      const body = bodies[uuid];
      const index = indexes[uuid];
      const matrix = matrices[uuid];
      const isDynamic = body.type === TYPE.DYNAMIC;

      // Only need to track first three syncs to deal with dynamic bodies which start out as such.
      const isTrackingInitialSyncs = body.initialSyncCount < 2;

      body.updateShapes();

      // If body starts out as dynamic (ie its initial sync count is zero but it is marked as dynamic)
      // wait a tick so host process can set its initial transform before physics starts driving it.
      if (body.initialSyncCount === 0 && isDynamic) {
        if (body.activationState === CONSTANTS.ACTIVATION_STATE.ACTIVE_TAG) {
          body.initialSyncCount++;
        }

        continue;
      }

      matrix.fromArray(objectMatricesFloatArray, index * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.MATRIX_OFFSET);

      if (isDynamic) {
        if (body.initialSyncCount === 1) {
          // Initial transform now set by host process for body which starts as dynamic. Initialize the body.
          matrices[uuid].fromArray(
            objectMatricesFloatArray,
            index * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.MATRIX_OFFSET
          );

          body.syncToPhysics(true);
        } else {
          // Dynamic body is now active and initialized, let physics engine drive its behavior.
          body.syncFromPhysics();
        }
      } else {
        body.syncToPhysics(false);
      }

      // Skip the work of incrementing the initialSyncCount unless we're still in the first 3 syncs.
      //
      // (Otherwise we don't care about it, since its only needed to initialize dynamic bodies that begin as such.)
      if (isTrackingInitialSyncs) {
        body.initialSyncCount++;
      }

      objectMatricesFloatArray.set(matrix.elements, index * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.MATRIX_OFFSET);

      objectMatricesFloatArray[
        index * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.LINEAR_VELOCITY_OFFSET
      ] = body.physicsBody.getLinearVelocity().length();
      objectMatricesFloatArray[
        index * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.ANGULAR_VELOCITY_OFFSET
      ] = body.physicsBody.getAngularVelocity().length();

      const ptr = getPointer(body.physicsBody);

      const collisions = world.collisions.get(ptr);
      for (let j = 0; j < BUFFER_CONFIG.BODY_DATA_SIZE - BUFFER_CONFIG.COLLISIONS_OFFSET; j++) {
        if (!collisions || j >= collisions.length || (isDynamic && isTrackingInitialSyncs)) {
          objectMatricesIntArray[index * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.COLLISIONS_OFFSET + j] = -1;
        } else {
          const collidingPtr = collisions[j];
          if (ptrToIndex[collidingPtr]) {
            objectMatricesIntArray[index * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.COLLISIONS_OFFSET + j] =
              ptrToIndex[collidingPtr];
          } else {
            objectMatricesIntArray[index * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.COLLISIONS_OFFSET + j] = -1;
          }
        }
      }
    }

    releaseBuffer();
  }
};
const initSharedArrayBuffer = (sharedArrayBuffer, maxBodies) => {
  /** BUFFER HEADER
   * When using SAB, the first 4 bytes (1 int) are reserved for signaling BUFFER_STATE
   * This is used to determine which thread is currently allowed to modify the SAB.
   * The second 4 bytes (1 float) is used for storing stepDuration for stats.
   */
  usingSharedArrayBuffer = true;
  headerIntArray = new Int32Array(sharedArrayBuffer, 0, BUFFER_CONFIG.HEADER_LENGTH);
  headerFloatArray = new Float32Array(sharedArrayBuffer, 0, BUFFER_CONFIG.HEADER_LENGTH);
  objectMatricesFloatArray = new Float32Array(
    sharedArrayBuffer,
    BUFFER_CONFIG.HEADER_LENGTH * 4,
    BUFFER_CONFIG.BODY_DATA_SIZE * maxBodies
  );
  objectMatricesIntArray = new Int32Array(
    sharedArrayBuffer,
    BUFFER_CONFIG.HEADER_LENGTH * 4,
    BUFFER_CONFIG.BODY_DATA_SIZE * maxBodies
  );
};

const initTransferrables = arrayBuffer => {
  objectMatricesFloatArray = new Float32Array(arrayBuffer);
  objectMatricesIntArray = new Int32Array(arrayBuffer);
};

function initDebug(debugSharedArrayBuffer, world) {
  const debugIndexArray = new Uint32Array(debugSharedArrayBuffer, 0, 1);
  const debugVerticesArray = new Float32Array(debugSharedArrayBuffer, 4, DefaultBufferSize);
  const debugColorsArray = new Float32Array(debugSharedArrayBuffer, 4 + DefaultBufferSize, DefaultBufferSize);
  world.getDebugDrawer(debugIndexArray, debugVerticesArray, debugColorsArray);
}

function addBody({ uuid, matrix, options }) {
  if (freeIndex !== -1) {
    const nextFreeIndex = freeIndexArray[freeIndex];
    freeIndexArray[freeIndex] = -1;

    indexes[uuid] = freeIndex;
    uuids.push(uuid);
    const transform = new THREE.Matrix4();
    transform.fromArray(matrix);
    matrices[uuid] = transform;

    objectMatricesFloatArray.set(transform.elements, freeIndex * BUFFER_CONFIG.BODY_DATA_SIZE);
    objectMatricesIntArray.fill(
      -1,
      freeIndex * BUFFER_CONFIG.BODY_DATA_SIZE + BUFFER_CONFIG.COLLISIONS_OFFSET,
      BUFFER_CONFIG.BODY_DATA_SIZE - BUFFER_CONFIG.COLLISIONS_OFFSET
    );
    bodies[uuid] = new Body(options || {}, transform, world);
    const ptr = getPointer(bodies[uuid].physicsBody);
    ptrToIndex[ptr] = freeIndex;

    postMessage({ type: MESSAGE_TYPES.BODY_READY, uuid, index: freeIndex });
    freeIndex = nextFreeIndex;
  }
}

function updateBody({ uuid, options }) {
  if (bodies[uuid]) {
    bodies[uuid].update(options);

    if (options.activationState === undefined) {
      bodies[uuid].physicsBody.activate(true);
    }
  }
}

function removeBody({ uuid }) {
  if (singleBodyShapes.has(uuid)) {
    const shapesUuid = singleBodyShapes.get(uuid);
    destroyShapes({ shapesUuid });

    // This body had its shape created and assign via ADD_SHAPE,
    // so no other bodies will use this shape and it can be destroyed.
    singleBodyShapes.delete(uuid);
  }

  delete ptrToIndex[getPointer(bodies[uuid].physicsBody)];
  bodies[uuid].destroy();
  delete bodies[uuid];
  delete matrices[uuid];
  const index = indexes[uuid];
  freeIndexArray[index] = freeIndex;
  freeIndex = index;
  delete indexes[uuid];
  uuids.splice(uuids.indexOf(uuid), 1);
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function destroyShapes({ shapesUuid }) {
  if (!shapes[shapesUuid]) return;

  // Remove shape from existing bodies
  for (const physicsShape of shapes[shapesUuid]) {
    for (const body of Object.values(bodies)) {
      body.removeShape(physicsShape);
    }

    ammoDestroy(physicsShape);
  }

  delete shapes[shapesUuid];
}

function createShapes({ shapesUuid, vertices, matrices, indexes, matrixWorld, options }) {
  shapes[shapesUuid] = createCollisionShapes(
    vertices,
    matrices,
    indexes,
    matrixWorld || IDENTITY_MATRIX,
    options || { type: SHAPE.BOX }
  );
}

function setShapes(bodyUuid, { shapesUuid }) {
  const physicsShapes = shapes[shapesUuid];
  const body = bodies[bodyUuid];
  body.setShapes(physicsShapes);
}

function addShapes({ bodyUuid, shapesUuid, vertices, matrices, indexes, matrixWorld, options }) {
  if (!bodies[bodyUuid]) return;

  const physicsShapes = createCollisionShapes(
    vertices,
    matrices,
    indexes,
    matrixWorld || IDENTITY_MATRIX,
    options || { type: SHAPE.BOX }
  );
  for (let i = 0; i < physicsShapes.length; i++) {
    const shape = physicsShapes[i];
    bodies[bodyUuid].addShape(shape);
  }
  shapes[shapesUuid] = physicsShapes;
  singleBodyShapes.set(bodyUuid, shapesUuid);
}

function updateShapesScale({ shapesUuid, matrixWorld, options }) {
  if (!tempVec3_1) return;
  const physicsShapes = shapes[shapesUuid];
  if (!physicsShapes) return;

  if (options.fit === FIT.ALL) {
    tmpMatrix.fromArray(matrixWorld);
    tmpVec3.setFromMatrixScale(tmpMatrix);
  }

  tempVec3_1.setValue(tmpVec3.x, tmpVec3.y, tmpVec3.z);
  for (let i = 0; i < physicsShapes.length; i++) {
    const shape = physicsShapes[i];
    shape.setLocalScaling(tempVec3_1);
  }
}

function addConstraint({ constraintId, bodyUuid, targetUuid, options }) {
  if (bodies[bodyUuid] && bodies[targetUuid]) {
    options = options || {};
    if (!options.hasOwnProperty("type")) {
      options.type = CONSTRAINT.LOCK;
    }
    const constraint = new Constraint(options, bodies[bodyUuid], bodies[targetUuid], world);
    constraints[constraintId] = constraint;
  }
}

function resetDynamicBody({ uuid }) {
  if (bodies[uuid]) {
    const body = bodies[uuid];
    body.physicsBody.getLinearVelocity().setValue(0, 0, 0);
    body.physicsBody.getAngularVelocity().setValue(0, 0, 0);
    body.initialSyncCount = 0;
  }
}

function activateBody({ uuid }) {
  if (bodies[uuid]) {
    bodies[uuid].physicsBody.activate();
  }
}

function applyImpulse({ uuid, x, y, z, rx, ry, rz }) {
  if (bodies[uuid]) {
    const physicsBody = bodies[uuid].physicsBody;

    tempVec3_1.setValue(x, y, z);
    tempVec3_2.setValue(rx, ry, rz);

    physicsBody.applyImpulse(tempVec3_1, tempVec3_2);
    physicsBody.activate();
  }
}

onmessage = async event => {
  if (event.data.type === MESSAGE_TYPES.INIT) {
    const AmmoModule = initializeWasm(event.data.wasmUrl);

    AmmoModule().then(Ammo => {
      getPointer = Ammo.getPointer;
      ammoDestroy = Ammo.destroy;

      const maxBodies = event.data.maxBodies ? event.data.maxBodies : BUFFER_CONFIG.MAX_BODIES;
      tempVec3_1 = new Ammo.btVector3(0, 0, 0);
      tempVec3_2 = new Ammo.btVector3(0, 0, 0);

      freeIndexArray = new Int32Array(maxBodies);
      for (let i = 0; i < maxBodies - 1; i++) {
        freeIndexArray[i] = i + 1;
      }
      freeIndexArray[maxBodies - 1] = -1;

      if (event.data.sharedArrayBuffer) {
        initSharedArrayBuffer(event.data.sharedArrayBuffer, maxBodies);
      } else if (event.data.arrayBuffer) {
        initTransferrables(event.data.arrayBuffer);
      } else {
        console.error("A valid ArrayBuffer or SharedArrayBuffer is required.");
      }

      world = new World(event.data.worldConfig || {});
      lastTick = performance.now();
      simulationRate = event.data.simulationRate === undefined ? CONSTANTS.SIMULATION_RATE : event.data.simulationRate;
      self.setTimeout(tick, simulationRate);
      postMessage({ type: MESSAGE_TYPES.READY });
    });
  } else if (event.data.type === MESSAGE_TYPES.TRANSFER_DATA) {
    if (event.data.simulationRate !== undefined) {
      simulationRate = event.data.simulationRate;
    }
    objectMatricesFloatArray = event.data.objectMatricesFloatArray;
    objectMatricesIntArray = new Int32Array(objectMatricesFloatArray.buffer);
  } else if (world) {
    switch (event.data.type) {
      case MESSAGE_TYPES.ADD_BODY: {
        messageQueue.push(event.data);
        break;
      }

      case MESSAGE_TYPES.UPDATE_BODY: {
        messageQueue.push(event.data);
        break;
      }

      case MESSAGE_TYPES.REMOVE_BODY: {
        const uuid = event.data.uuid;
        if (uuids.indexOf(uuid) !== -1) {
          messageQueue.push(event.data);
        }
        break;
      }

      case MESSAGE_TYPES.ADD_SHAPES: {
        const bodyUuid = event.data.bodyUuid;
        if (bodies[bodyUuid]) {
          addShapes(event.data);
        } else {
          messageQueue.push(event.data);
        }
        break;
      }

      case MESSAGE_TYPES.CREATE_SHAPES: {
        createShapes(event.data);
        break;
      }

      case MESSAGE_TYPES.DESTROY_SHAPES: {
        const shapesUuid = event.data.shapesUuid;
        if (shapes[shapesUuid]) {
          destroyShapes(event.data);
        } else {
          messageQueue.push(event.data);
        }
        break;
      }

      case MESSAGE_TYPES.SET_SHAPES: {
        messageQueue.push(event.data);
        break;
      }

      case MESSAGE_TYPES.REMOVE_SHAPES: {
        const bodyUuid = event.data.bodyUuid;
        const shapesUuid = event.data.shapesUuid;
        if (bodies[bodyUuid] && shapes[shapesUuid]) {
          // If this shape was assigned via ADD_SHAPE, destroy it
          // (which will also remove it from the body)
          if (singleBodyShapes.get(bodyUuid) === shapesUuid) {
            destroyShapes({ shapesUuid });
            singleBodyShapes.delete(bodyUuid);
          } else {
            for (let i = 0; i < shapes[shapesUuid].length; i++) {
              const shape = shapes[shapesUuid][i];
              bodies[bodyUuid].removeShape(shape);
            }
          }
        }
        break;
      }

      case MESSAGE_TYPES.UPDATE_SHAPES_SCALE: {
        const shapesUuid = event.data.shapesUuid;
        if (shapes[shapesUuid]) {
          updateShapesScale(event.data);
        } else {
          messageQueue.push(event.data);
        }
        break;
      }

      case MESSAGE_TYPES.ADD_CONSTRAINT: {
        const bodyUuid = event.data.bodyUuid;
        const targetUuid = event.data.targetUuid;
        if (bodies[bodyUuid] && bodies[targetUuid]) {
          addConstraint(event.data);
        } else {
          messageQueue.push(event.data);
        }
        break;
      }

      case MESSAGE_TYPES.REMOVE_CONSTRAINT: {
        const constraintId = event.data.constraintId;
        if (constraints[constraintId]) {
          constraints[constraintId].destroy();
          delete constraints[constraintId];
        }
        break;
      }

      case MESSAGE_TYPES.ENABLE_DEBUG: {
        const enable = event.data.enable;
        if (!world.debugDrawer) {
          initDebug(event.data.debugSharedArrayBuffer, world);
        }

        if (world.debugDrawer) {
          if (enable) {
            world.debugDrawer.enable();
          } else {
            world.debugDrawer.disable();
          }
        }
        break;
      }

      case MESSAGE_TYPES.RESET_DYNAMIC_BODY:
      case MESSAGE_TYPES.APPLY_IMPULSE:
      case MESSAGE_TYPES.ACTIVATE_BODY:
        messageQueue.push(event.data);
        break;
    }
  } else {
    console.error("Error: World Not Initialized", event.data);
  }
};
