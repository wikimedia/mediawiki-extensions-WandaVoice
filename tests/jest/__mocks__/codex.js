/* eslint-env node */
const slotStub = ( name ) => ( {
	name,
	inheritAttrs: false,
	template: '<div><slot name="title" /><slot /></div>'
} );

module.exports = {
	CdxButton: slotStub( 'CdxButton' ),
	CdxProgressBar: slotStub( 'CdxProgressBar' ),
	CdxMessage: slotStub( 'CdxMessage' )
};
