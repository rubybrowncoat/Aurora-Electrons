--select * from FCT_GroundUnitFormation where OriginalTemplateID = 4188
--update FCT_GroundUnitFormation set OriginalTemplateID = 4192 where OriginalTemplateID = 4188
--update FCT_GroundUnitFormation set OriginalTemplateID = 4192 where ReplacementTemplateID = 4192

--select sc.ClassName, cgt.* from FCT_ShipClass as sc inner join FCT_ClassGroundTemplates as cgt on cgt.ShipClassID = sc.ShipClassID where ClassName like 'Oaf%'
--select * from FCT_ClassGroundTemplates where ShipClassID = 75234

--select * from FCT_Population as p where p.PopName like ''
			--	'beg-a2m9%'	-- 49494
			--	'zzz-acom9%'  -- 49061
			--	'%fia-a2m1%'	-- 49362
--select * from FCT_GroundUnitFormation where PopulationID = 49362 --and Abbreviation in ('inf','INF')
--select * from FCT_GroundUnitFormation where PopulationID = 49043 and OriginalTemplateID = 4186

--select * from FCT_GroundUnitFormation where Name like	'adhoc boardies 100t 20210819%'
/*
update FCT_GroundUnitFormation set 
	OriginalTemplateID = 4206
	, ReplacementTemplateID = 4206 
--select * from FCT_GroundUnitFormation
where 
PopulationID = 49061
-- and OriginalTemplateID = 4186 
 and name like 'adhoc%'
--*/
--select * from FCT_GroundUnitFormationTemplate where name like '%Boardies100t%' -- 4206

/*
ICAPColdMtLg25k	INF	4186
ICAPColdMtLg25k - 2118	INF	4189
ICAPColdMtLg25k - 2120	INF	4200
*/

/*
Name	Abbreviation	TemplateID
Boardies100t			BRD	4188
 Boardies100t - 2118	BRD	4192
 Boardies100t - 2120	BRD	4206

*/

/*
select * from FCT_GroundUnitFormation where OriginalTemplateID = 4186
-- and OriginalTemplateID <> 4192
and PopulationID = 49043
*/

--
/*
update FCT_GroundUnitFormation set ReplacementPriority = 99 where FormationID in
(
	select 
		--gufe.Units, * ,
		guf.FormationID
	from  FCT_GroundUnitFormation as guf 
	inner join 
	(
		select 
			gufe.FormationID
			,sum(gufe.Units) as Units
		FROM
			FCT_GroundUnitFormationElement as gufe 
		group by
			gufe.FormationID
	) as gufe on gufe.FormationID = guf.FormationID
	inner join fct_ship as s on s.ShipID = guf.ShipID
	inner join fct_fleet as f on f.FleetID = s.FleetID
	where 
		guf.Abbreviation in ('brd','BRD') 
	and 
		guf.ReplacementTemplateID in (4188,4192)
	AND
		f.SystemID = (select SystemID from FCT_RaceSysSurvey where Name = 'Fia%')
	--AND		gufe.units < 8
	order by gufe.units
) -- */