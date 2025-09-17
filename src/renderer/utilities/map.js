export class Vector3 {
  static EPSILON = 1e-6

  // Internal scratch
  static _t1 = new Vector3()
  static _t2 = new Vector3()

  constructor (x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }

  // Basics
  set (x, y, z) {
    this.x = x
    this.y = y
    this.z = z

    return this
  }

  copy (vector) {
    this.x = vector.x
    this.y = vector.y
    this.z = vector.z

    return this
  }

  clone () {
    return new Vector3(this.x, this.y, this.z)
  }

  equals (vector, threshold = Vector3.EPSILON) {
    return (Math.abs(this.x - vector.x) <= threshold) && (Math.abs(this.y - vector.y) <= threshold) && (Math.abs(this.z - vector.z) <= threshold)
  }

  // Array interoperability
  toArray (outArray = [], offset = 0) {
    outArray[offset] = this.x
    outArray[offset + 1] = this.y
    outArray[offset + 2] = this.z

    return outArray
  }

  fromArray (array, offset = 0) {
    this.x = array[offset]
    this.y = array[offset + 1]
    this.z = array[offset + 2]

    return this
  }

  toFloat32Array (out = new Float32Array(3), offset = 0) {
    out[offset] = this.x
    out[offset + 1] = this.y
    out[offset + 2] = this.z

    return out
  }

  static fromArray (array, offset = 0, out = new Vector3()) {
    out.x = array[offset]
    out.y = array[offset + 1]
    out.z = array[offset + 2]

    return out
  }

  // Arithmetic operations
  add (vector) {
    this.x += vector.x
    this.y += vector.y
    this.z += vector.z

    return this
  }

  addScalar (scalar) {
    this.x += scalar
    this.y += scalar
    this.z += scalar

    return this
  }

  sub (vector) {
    this.x -= vector.x
    this.y -= vector.y
    this.z -= vector.z

    return this
  }

  subScalar (scalar) {
    this.x -= scalar
    this.y -= scalar
    this.z -= scalar

    return this
  }

  multiply (vector) {
    this.x *= vector.x
    this.y *= vector.y
    this.z *= vector.z

    return this
  }

  multiplyScalar (scalar) {
    this.x *= scalar
    this.y *= scalar
    this.z *= scalar

    return this
  }

  divide (vector) {
    this.x /= vector.x
    this.y /= vector.y
    this.z /= vector.z

    return this
  }

  divideScalar (scalar) {
    if (scalar !== 0) {
      const invScalar = 1 / scalar

      this.x *= invScalar
      this.y *= invScalar
      this.z *= invScalar
    } else {
      this.x = 0
      this.y = 0
      this.z = 0
    }

    return this
  }

  negate () {
    this.x = -this.x
    this.y = -this.y
    this.z = -this.z

    return this
  }

  // Min / Max / Clamp
  min (vector) {
    this.x = Math.min(this.x, vector.x)
    this.y = Math.min(this.y, vector.y)
    this.z = Math.min(this.z, vector.z)

    return this
  }

  max (vector) {
    this.x = Math.max(this.x, vector.x)
    this.y = Math.max(this.y, vector.y)
    this.z = Math.max(this.z, vector.z)

    return this
  }

  clamp (min, max) {
    this.x = Math.max(min.x, Math.min(max.x, this.x))
    this.y = Math.max(min.y, Math.min(max.y, this.y))
    this.z = Math.max(min.z, Math.min(max.z, this.z))

    return this
  }

  clampScalar (minVal, maxVal) {
    this.x = Math.max(minVal, Math.min(maxVal, this.x))
    this.y = Math.max(minVal, Math.min(maxVal, this.y))
    this.z = Math.max(minVal, Math.min(maxVal, this.z))

    return this
  }

  clampLength (min, max) {
    const length = this.length()

    return this.setLength(Math.max(min, Math.min(max, length)))
  }

  // Metrics
  lengthSquared () {
    return this.x * this.x + this.y * this.y + this.z * this.z
  }

  length () {
    return Math.hypot(this.x, this.y, this.z)
  }

  manhattanLength () {
    return Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.z)
  }

  distanceTo (vector) {
    return Math.hypot(this.x - vector.x, this.y - vector.y, this.z - vector.z)
  }

  distanceToSquared (vector) {
    const dx = this.x - vector.x
    const dy = this.y - vector.y
    const dz = this.z - vector.z

    return dx * dx + dy * dy + dz * dz
  }

  // Normalization
  normalize () {
    const length = this.length()

    if (length > 0) {
      this.divideScalar(length)
    } else {
      this.set(0, 0, 0)
    }

    return this
  }

  setLength (newLength) {
    const length = this.length()

    if (length > 0) {
      this.multiplyScalar(newLength / length)
    } else {
      this.set(newLength, 0, 0)
    }

    return this
  }

  // Products
  dot (vector) {
    return this.x * vector.x + this.y * vector.y + this.z * vector.z
  }

  cross (vector) {
    const ax = this.x
    const ay = this.y
    const az = this.z

    this.x = ay * vector.z - az * vector.y
    this.y = az * vector.x - ax * vector.z
    this.z = ax * vector.y - ay * vector.x

    return this
  }

  // Angles
  angleTo (vector) {
    const denominator = Math.sqrt(this.lengthSquared() * vector.lengthSquared())

    if (denominator === 0) return Math.PI / 2

    const theta = this.dot(vector) / denominator

    // clamp, to handle numerical problems
    return Math.acos(Math.min(Math.max(theta, -1), 1))
  }

  // Utilities
  lerp (vector, t) {
    this.x += (vector.x - this.x) * t
    this.y += (vector.y - this.y) * t
    this.z += (vector.z - this.z) * t

    return this
  }

  isFinite () {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z)
  }

  toString () {
    return `Vector3(${this.x}, ${this.y}, ${this.z})`
  }

  // Constants
  static get ZERO () { return new Vector3(0, 0, 0) }
  static get ONE () { return new Vector3(1, 1, 1) }
}

export class Vector2 {
  static EPSILON = 1e-6

  // Internal scratch
  static _t1 = new Vector2()

  constructor (x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  // Basics
  set (x, y) {
    this.x = x
    this.y = y

    return this
  }

  copy (vector) {
    this.x = vector.x
    this.y = vector.y

    return this
  }

  clone () {
    return new Vector2(this.x, this.y)
  }

  equals (vector, threshold = Vector2.EPSILON) {
    return (Math.abs(this.x - vector.x) <= threshold) && (Math.abs(this.y - vector.y) <= threshold)
  }

  // Array interoperability
  toArray (outArray = [], offset = 0) {
    outArray[offset] = this.x
    outArray[offset + 1] = this.y

    return outArray
  }

  fromArray (array, offset = 0) {
    this.x = array[offset]
    this.y = array[offset + 1]

    return this
  }

  toFloat32Array (out = new Float32Array(2), offset = 0) {
    out[offset] = this.x
    out[offset + 1] = this.y

    return out
  }

  static fromArray (array, offset = 0, out = new Vector2()) {
    out.x = array[offset]
    out.y = array[offset + 1]

    return out
  }

  // Arithmetic operations
  add (vector) {
    this.x += vector.x
    this.y += vector.y

    return this
  }

  addScalar (scalar) {
    this.x += scalar
    this.y += scalar

    return this
  }

  sub (vector) {
    this.x -= vector.x
    this.y -= vector.y

    return this
  }

  subScalar (scalar) {
    this.x -= scalar
    this.y -= scalar

    return this
  }

  multiply (vector) {
    this.x *= vector.x
    this.y *= vector.y

    return this
  }

  multiplyScalar (scalar) {
    this.x *= scalar
    this.y *= scalar

    return this
  }

  divide (vector) {
    this.x /= vector.x
    this.y /= vector.y

    return this
  }

  divideScalar (scalar) {
    if (scalar !== 0) {
      const invScalar = 1 / scalar

      this.x *= invScalar
      this.y *= invScalar
    } else {
      this.x = 0
      this.y = 0
    }

    return this
  }

  negate () {
    this.x = -this.x
    this.y = -this.y

    return this
  }

  // Min / Max / Clamp
  min (vector) {
    this.x = Math.min(this.x, vector.x)
    this.y = Math.min(this.y, vector.y)

    return this
  }

  max (vector) {
    this.x = Math.max(this.x, vector.x)
    this.y = Math.max(this.y, vector.y)

    return this
  }

  clamp (min, max) {
    this.x = Math.max(min.x, Math.min(max.x, this.x))
    this.y = Math.max(min.y, Math.min(max.y, this.y))

    return this
  }

  clampScalar (minVal, maxVal) {
    this.x = Math.max(minVal, Math.min(maxVal, this.x))
    this.y = Math.max(minVal, Math.min(maxVal, this.y))

    return this
  }

  clampLength (min, max) {
    const length = this.length()

    return this.setLength(Math.max(min, Math.min(max, length)))
  }

  // Metrics
  lengthSquared () {
    return this.x * this.x + this.y * this.y
  }

  length () {
    return Math.hypot(this.x, this.y)
  }

  manhattanLength () {
    return Math.abs(this.x) + Math.abs(this.y)
  }

  distanceTo (vector) {
    return Math.hypot(this.x - vector.x, this.y - vector.y)
  }

  distanceToSquared (vector) {
    const dx = this.x - vector.x
    const dy = this.y - vector.y

    return dx * dx + dy * dy
  }

  // Normalization
  normalize () {
    const length = this.length()

    if (length > 0) {
      this.divideScalar(length)
    } else {
      this.set(0, 0)
    }

    return this
  }

  setLength (newLength) {
    const length = this.length()

    if (length > 0) {
      this.multiplyScalar(newLength / length)
    } else {
      this.set(newLength, 0)
    }

    return this
  }

  // Products
  dot (vector) {
    return this.x * vector.x + this.y * vector.y
  }

  cross (vector) {
    return this.x * vector.y - this.y * vector.x
  }

  // Angles
  angle () { // orientation from +X
    return Math.atan2(this.y, this.x)
  }

  angleTo (vector) {
    const denominator = Math.sqrt(this.lengthSquared() * vector.lengthSquared())

    if (denominator === 0) return Math.PI / 2

    const theta = this.dot(vector) / denominator

    // clamp, to handle numerical problems
    return Math.acos(Math.min(Math.max(theta, -1), 1))
  }

  signedAngleTo (vector) { // Signed angle from this → vector, in (-π, π]. Positive = CCW.
    const dot = this.dot(vector)
    const crossZ = this.cross(vector)

    return Math.atan2(crossZ, dot)
  }

  // Utilities
  lerp (vector, t) {
    this.x += (vector.x - this.x) * t
    this.y += (vector.y - this.y) * t

    return this
  }

  isFinite () {
    return Number.isFinite(this.x) && Number.isFinite(this.y)
  }

  toString () {
    return `Vector2(${this.x}, ${this.y})`
  }

  // Constants
  static get ZERO () { return new Vector2(0, 0) }
  static get ONE () { return new Vector2(1, 1) }
}
