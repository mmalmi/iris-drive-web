<script lang="ts">
  import DriveSetup from '../components/DriveSetup.svelte';

  interface Props {
    payload: string;
  }

  let { payload }: Props = $props();
  let inviteUrl = $derived(`https://drive.iris.to/invite/${payload}`);
</script>

<DriveSetup initialOwnerInput={inviteUrl} />
