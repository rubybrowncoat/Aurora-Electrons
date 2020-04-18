<template>
  <b-navbar type="is-primary" fixed-top :shadow="true">
    <template slot="start">
      <b-navbar-item tag="nuxt-link" to="/" exact>
        Production Recap
      </b-navbar-item>
      <b-navbar-item tag="nuxt-link" to="/engines" exact>
        Engine Planner
      </b-navbar-item>
    </template>
  </b-navbar>
</template>

<script>
export default {

}
</script>

<style lang="scss" scoped>
  nav {
    width: 100%;
    display: flex;
    justify-content: center;
    
    div {
      height: 100%;
      margin: 0 20px;
      display: flex;
      align-items: center;
    }
  }
</style>

<style scoped>
    .main-header {
        height: 50px;
        display: flex;
        background-color: #364758;

        position: fixed;
        top: 0;
        width: 100vw;

        z-index: 42;
    }
</style>
