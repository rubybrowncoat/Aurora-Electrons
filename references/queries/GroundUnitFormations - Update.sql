SELECT
	*
FROM
	FCT_GroundUnitFormation as guf
WHERE
	guf.Abbreviation = 'xb'
	
	
update FCT_GroundUnitFormation set ReplacementTemplateID = 4188 where Abbreviation = 'xb'
update FCT_GroundUnitFormation set Abbreviation = 'BRD' where Abbreviation = 'xb'

update FCT_GroundUnitFormation set OriginalTemplateID = 4188 where ReplacementTemplateID = 4188 and OriginalTemplateID = 0