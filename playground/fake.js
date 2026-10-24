// Shared behaviour for the practice pages: the password "wrong" fails, anything else succeeds.
function fakeSubmit(password, onSuccess) {
  setTimeout(() => {
    if (password === 'wrong') {
      document.querySelector('#msg').innerHTML = '<p class="error" role="alert">Incorrect password. Try again.</p>';
    } else {
      onSuccess();
    }
  }, 300);
}
