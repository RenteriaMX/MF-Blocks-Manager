import React from 'react';

// El host (volto-mfblocks) inyecta authToken y apiPath como props.
// authToken es el JWT del usuario (o null si es anonimo); apiPath es la URL
// base del backend Plone. Un bloque real los usaria asi para autenticar:
//
//   const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
//   fetch(`${apiPath}/@some-protected-endpoint`, { headers });
//
// Este ejemplo solo muestra si el token llego, como referencia de uso.
const SpacerView = ({ data, authToken }) => {
  const height = Math.max(0, Math.min(Number(data?.height) || 100, 2000));

  if (data?.debugAuth) {
    return (
      <div style={{ height: `${height}px` }} data-auth={authToken ? 'auth' : 'anon'}>
        {authToken ? 'auth' : 'anon'}
      </div>
    );
  }

  return <div style={{ height: `${height}px` }} />;
};

export default SpacerView;
